import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'proc_test_';
const BRANCH_PREFIX = 'Proc Test ';

// ── Cleanup helpers ───────────────────────────────────────────────────────────

async function cleanTestPOs() {
  await db.query(`
    DELETE FROM po_receipt_items WHERE receipt_id IN (
      SELECT id FROM po_receipts WHERE po_id IN (
        SELECT id FROM purchase_orders WHERE notes LIKE '%proc_test%'
      )
    )
  `);
  await db.query(`
    DELETE FROM po_receipts WHERE po_id IN (
      SELECT id FROM purchase_orders WHERE notes LIKE '%proc_test%'
    )
  `);
  await db.query(`
    DELETE FROM po_line_items WHERE po_id IN (
      SELECT id FROM purchase_orders WHERE notes LIKE '%proc_test%'
    )
  `);
  await db.query(`DELETE FROM purchase_orders WHERE notes LIKE '%proc_test%'`);
}

async function getTestBook(): Promise<number> {
  const result = await db.query(`SELECT id FROM books WHERE is_active = true LIMIT 1`);
  if (!result.rows.length) throw new Error('No active books found');
  return result.rows[0].id as number;
}

async function getTestSupplier(): Promise<number> {
  // Try to find an active, non-blacklisted supplier
  const result = await db.query(
    `SELECT id FROM suppliers WHERE is_active = true AND is_blacklisted = false LIMIT 1`,
  );
  if (result.rows.length) return result.rows[0].id as number;

  // Create one if none exists
  const created = await db.query(
    `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type)
     VALUES ('Proc Test Supplier', '{"phone":"555-PROC"}', 7, 'external')
     RETURNING id`,
  );
  return created.rows[0].id as number;
}

async function getTestLocation(branchId: number): Promise<number> {
  const result = await db.query(
    `SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`,
    [branchId],
  );
  if (result.rows.length) return result.rows[0].id as number;

  const created = await db.query(
    `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Proc Test Location', true) RETURNING id`,
    [branchId],
  );
  return created.rows[0].id as number;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Procurement — Purchase Orders', () => {
  let adminToken: string;
  let managerToken: string;
  let purchasorToken: string;
  let stockClerkToken: string;
  let financeToken: string;
  let branchId: number;
  let bookId: number;
  let supplierId: number;
  let locationId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    await cleanTestPOs();

    const branch = await createTestBranch({ name: 'Proc Test Branch' });
    branchId = branch.branchId;

    const admin = await createTestStaff({ username: 'proc_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    const mgr = await createTestStaff({ username: 'proc_test_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;

    const purchasor = await createTestStaff({ username: 'proc_test_purchasor', role: 'Purchasor', branchId });
    purchasorToken = purchasor.token;

    const clerk = await createTestStaff({ username: 'proc_test_clerk', role: 'Stock_Clerk', branchId });
    stockClerkToken = clerk.token;

    const finance = await createTestStaff({ username: 'proc_test_finance', role: 'Finance_Officer', branchId });
    financeToken = finance.token;

    bookId = await getTestBook();
    supplierId = await getTestSupplier();
    locationId = await getTestLocation(branchId);

    // Ensure inventory row exists
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
       VALUES ($1, $2, 0, 5, 0) ON CONFLICT DO NOTHING`,
      [bookId, locationId],
    );
  });

  afterAll(async () => {
    await cleanTestPOs();
    await db.query(
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`,
      [branchId],
    );
    await db.query(
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`,
      [branchId],
    );
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── 1. Create PO → correct total_amount ──────────────────────────────────

  it('1. Create PO — correct total_amount calculated', async () => {
    const res = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        currency: 'USD',
        notes: 'proc_test create',
        lineItems: [
          { bookId, quantity: 5, unitCost: 10.00 },
          { bookId, quantity: 3, unitCost: 20.00 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(Number(res.body.totalAmount)).toBe(110.00); // 5*10 + 3*20
    expect(res.body.lineItems).toHaveLength(2);
  });

  // ── 2. Submit below threshold → auto-approved ─────────────────────────────

  it('2. Submit below threshold → auto-approved', async () => {
    // Ensure threshold is 1000 (default)
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        notes: 'proc_test below threshold',
        lineItems: [{ bookId, quantity: 1, unitCost: 50.00 }],
      });
    expect(createRes.status).toBe(201);
    const poId = createRes.body.id;

    const submitRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(submitRes.status).toBe(200);
    expect(submitRes.body.status).toBe('approved');
    expect(submitRes.body.approvedBy).toBeTruthy();
  });

  // ── 3. Submit above threshold → pending_approval ──────────────────────────

  it('3. Submit above threshold → pending_approval', async () => {
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        notes: 'proc_test above threshold',
        lineItems: [{ bookId, quantity: 100, unitCost: 20.00 }], // 2000 > 1000
      });
    expect(createRes.status).toBe(201);
    const poId = createRes.body.id;

    const submitRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(submitRes.status).toBe(200);
    expect(submitRes.body.status).toBe('pending_approval');
    expect(submitRes.body.approvedBy).toBeNull();
  });

  // ── 4. Approve PO (Admin role) ────────────────────────────────────────────

  it('4. Approve PO (Admin role)', async () => {
    // Create and submit above threshold
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        notes: 'proc_test approve',
        lineItems: [{ bookId, quantity: 200, unitCost: 10.00 }], // 2000 > 1000
      });
    const poId = createRes.body.id;

    await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    const approveRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('approved');
    expect(approveRes.body.approvedBy).toBeTruthy();
  });

  // ── 5. Purchasor cannot approve (403) ─────────────────────────────────────

  it('5. Purchasor cannot approve (403)', async () => {
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${purchasorToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        notes: 'proc_test purchasor approve attempt',
        lineItems: [{ bookId, quantity: 200, unitCost: 10.00 }],
      });
    const poId = createRes.body.id;

    await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/submit`)
      .set('Authorization', `Bearer ${purchasorToken}`)
      .set('X-Branch-Id', String(branchId));

    const approveRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/approve`)
      .set('Authorization', `Bearer ${purchasorToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(approveRes.status).toBe(403);
  });

  // ── 6. Receive partial → status = partially_received, inventory updated ───

  it('6. Receive partial → status = partially_received, inventory updated', async () => {
    // Create, submit (auto-approve below threshold), then receive partial
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        notes: 'proc_test partial receive',
        lineItems: [{ bookId, quantity: 10, unitCost: 5.00 }], // 50 < 1000
      });
    expect(createRes.status).toBe(201);
    const poId = createRes.body.id;
    const lineItemId = Number(createRes.body.lineItems[0].id);

    // Submit (auto-approved)
    const submitRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(submitRes.body.status).toBe('approved');

    // Get inventory before
    const invBefore = await db.query(
      `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, locationId],
    );
    const qtyBefore = invBefore.rows[0]?.quantity ?? 0;

    // Receive 4 of 10
    const receiveRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId,
        items: [{ poLineItemId: lineItemId, quantityReceived: 4 }],
        notes: 'partial receipt',
      });

    expect(receiveRes.status).toBe(200);
    expect(receiveRes.body.status).toBe('partially_received');

    // Verify inventory increased
    const invAfter = await db.query(
      `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, locationId],
    );
    expect(invAfter.rows[0].quantity).toBe(qtyBefore + 4);
  });

  // ── 7. Over-receive → rejected (422) ─────────────────────────────────────

  it('7. Over-receive → rejected (422)', async () => {
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        notes: 'proc_test over receive',
        lineItems: [{ bookId, quantity: 5, unitCost: 5.00 }],
      });
    const poId = createRes.body.id;
    const lineItemId = Number(createRes.body.lineItems[0].id);

    await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    const receiveRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId,
        items: [{ poLineItemId: lineItemId, quantityReceived: 10 }], // 10 > 5
      });

    expect(receiveRes.status).toBe(422);
    expect(receiveRes.body.error).toBe('OVER_RECEIPT');
  });

  // ── 8. Receive remaining → status = received ──────────────────────────────

  it('8. Receive remaining → status = received', async () => {
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        notes: 'proc_test full receive',
        lineItems: [{ bookId, quantity: 6, unitCost: 5.00 }],
      });
    const poId = createRes.body.id;
    const lineItemId = Number(createRes.body.lineItems[0].id);

    await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    // Receive all 6
    const receiveRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId,
        items: [{ poLineItemId: lineItemId, quantityReceived: 6 }],
      });

    expect(receiveRes.status).toBe(200);
    expect(receiveRes.body.status).toBe('received');
  });

  // ── 9. Cancel draft → succeeds ────────────────────────────────────────────

  it('9. Cancel draft → succeeds', async () => {
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        notes: 'proc_test cancel draft',
        lineItems: [{ bookId, quantity: 1, unitCost: 5.00 }],
      });
    const poId = createRes.body.id;

    const cancelRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('cancelled');
  });

  // ── 10. Cancel after receipt → rejected ──────────────────────────────────

  it('10. Cancel after receipt → rejected', async () => {
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        notes: 'proc_test cancel after receipt',
        lineItems: [{ bookId, quantity: 10, unitCost: 5.00 }],
      });
    const poId = createRes.body.id;
    const lineItemId = Number(createRes.body.lineItems[0].id);

    await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    // Receive some
    await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ poLineItemId: lineItemId, quantityReceived: 2 }] });

    // Try to cancel — should fail
    const cancelRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(cancelRes.status).toBe(422);
    expect(cancelRes.body.error).toBe('PO_INVALID_STATUS');
  });

  // ── 11. Inventory history created with correct movement_type and reference_type ──

  it('11. Inventory history created with movement_type=stock_in and reference_type=purchase_order', async () => {
    // Find a PO receipt we created in test 6 (partial receive)
    const histRes = await db.query(
      `SELECT ih.movement_type, ih.reference_type, ih.reference_id
       FROM inventory_history ih
       JOIN locations l ON l.id = ih.location_id
       WHERE l.branch_id = $1
         AND ih.movement_type = 'stock_in'
         AND ih.reference_type = 'purchase_order'
       ORDER BY ih.id DESC
       LIMIT 1`,
      [branchId],
    );

    expect(histRes.rows.length).toBeGreaterThan(0);
    const row = histRes.rows[0] as { movement_type: string; reference_type: string; reference_id: string };
    expect(row.movement_type).toBe('stock_in');
    expect(row.reference_type).toBe('purchase_order');
    expect(row.reference_id).toBeTruthy();
  });

  // ── Additional: Finance_Officer can read POs ──────────────────────────────

  it('Finance_Officer can list purchase orders', async () => {
    const res = await request(getTestApp())
      .get('/api/purchase-orders')
      .set('Authorization', `Bearer ${financeToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  // ── Additional: Stock_Clerk can read but not create ───────────────────────

  it('Stock_Clerk can list POs but cannot create', async () => {
    const listRes = await request(getTestApp())
      .get('/api/purchase-orders')
      .set('Authorization', `Bearer ${stockClerkToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(listRes.status).toBe(200);

    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${stockClerkToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ supplierId, branchId, notes: 'proc_test clerk create', lineItems: [{ bookId, quantity: 1, unitCost: 5 }] });
    expect(createRes.status).toBe(403);
  });

  // ── Additional: Manager can approve ──────────────────────────────────────

  it('Manager can approve a pending_approval PO', async () => {
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        notes: 'proc_test mgr approve',
        lineItems: [{ bookId, quantity: 200, unitCost: 10.00 }],
      });
    const poId = createRes.body.id;

    await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    const approveRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/approve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('approved');
  });

  // ── 15. PO can be received at a specific (non-default) location ───────────

  it('15. PO can be received at a specific location (not just default)', async () => {
    // Create a second location in the test branch
    const loc2Res = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Proc Test Location 2', false) RETURNING id`,
      [branchId],
    );
    const location2Id = loc2Res.rows[0].id as number;

    // Ensure inventory row exists for location2
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
       VALUES ($1, $2, 0, 5, 0) ON CONFLICT DO NOTHING`,
      [bookId, location2Id],
    );

    const invBefore = await db.query(
      `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, location2Id],
    );
    const qtyBefore = invBefore.rows[0]?.quantity ?? 0;

    // Create PO and submit (auto-approve)
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        notes: 'proc_test specific location receive',
        lineItems: [{ bookId, quantity: 5, unitCost: 5.00 }],
      });
    expect(createRes.status).toBe(201);
    const poId = createRes.body.id;
    const lineItemId = Number(createRes.body.lineItems[0].id);

    await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    // Receive at location2 (not the default)
    const receiveRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId: location2Id,
        items: [{ poLineItemId: lineItemId, quantityReceived: 5 }],
        notes: 'proc_test specific location',
      });

    expect(receiveRes.status).toBe(200);
    expect(receiveRes.body.status).toBe('received');

    // Verify inventory updated at location2
    const invAfter = await db.query(
      `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, location2Id],
    );
    expect(invAfter.rows[0].quantity).toBe(qtyBefore + 5);

    // Verify inventory at default location was NOT changed by this receipt
    const receipt = receiveRes.body.receipts?.find((r: { locationId: number }) => r.locationId === location2Id);
    expect(receipt).toBeTruthy();

    // Cleanup
    await db.query(`DELETE FROM inventory_history WHERE location_id = $1`, [location2Id]);
    await db.query(`DELETE FROM inventory WHERE location_id = $1`, [location2Id]);
    await db.query(`
      DELETE FROM po_receipt_items WHERE receipt_id IN (
        SELECT id FROM po_receipts WHERE location_id = $1
      )
    `, [location2Id]);
    await db.query(`DELETE FROM po_receipts WHERE location_id = $1`, [location2Id]);
    await db.query(`DELETE FROM locations WHERE id = $1`, [location2Id]);
  });

  // ── 16. Receiving location defaults to PO's receiving_location_id when not specified ──

  it('16. Receiving location defaults to PO receiving_location_id when locationId not specified in GRN', async () => {
    // Create a dedicated location for this test
    const loc3Res = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Proc Test Location 3', false) RETURNING id`,
      [branchId],
    );
    const location3Id = loc3Res.rows[0].id as number;

    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
       VALUES ($1, $2, 0, 5, 0) ON CONFLICT DO NOTHING`,
      [bookId, location3Id],
    );

    const invBefore = await db.query(
      `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, location3Id],
    );
    const qtyBefore = invBefore.rows[0]?.quantity ?? 0;

    // Create PO with explicit receivingLocationId
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        supplierId,
        branchId,
        receivingLocationId: location3Id,
        notes: 'proc_test default receiving location',
        lineItems: [{ bookId, quantity: 3, unitCost: 5.00 }],
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.receivingLocationId).toBe(location3Id);
    const poId = createRes.body.id;
    const lineItemId = Number(createRes.body.lineItems[0].id);

    // Submit (auto-approve)
    await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    // Receive WITHOUT specifying locationId — should fall back to PO's receiving_location_id
    const receiveRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        items: [{ poLineItemId: lineItemId, quantityReceived: 3 }],
        notes: 'proc_test no location specified',
      });

    expect(receiveRes.status).toBe(200);
    expect(receiveRes.body.status).toBe('received');

    // Verify inventory updated at location3 (the PO's receiving_location_id)
    const invAfter = await db.query(
      `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, location3Id],
    );
    expect(invAfter.rows[0].quantity).toBe(qtyBefore + 3);

    // Cleanup
    await db.query(`DELETE FROM inventory_history WHERE location_id = $1`, [location3Id]);
    await db.query(`DELETE FROM inventory WHERE location_id = $1`, [location3Id]);
    await db.query(`
      DELETE FROM po_receipt_items WHERE receipt_id IN (
        SELECT id FROM po_receipts WHERE location_id = $1
      )
    `, [location3Id]);
    await db.query(`DELETE FROM po_receipts WHERE location_id = $1`, [location3Id]);
    // Null out receiving_location_id on POs referencing this location before deleting
    await db.query(`UPDATE purchase_orders SET receiving_location_id = NULL WHERE receiving_location_id = $1`, [location3Id]);
    await db.query(`DELETE FROM locations WHERE id = $1`, [location3Id]);
  });
});
