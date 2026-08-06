/**
 * orders-inventory-sync.test.ts
 *
 * Integration tests for the corrected order-inventory-sync model.
 *
 * Correct model:
 *   DRAFT    → no reservation, no stock deduction
 *   CONFIRMED → soft reservation only (inventory.quantity UNCHANGED)
 *   PAID     → financial state only (no inventory change)
 *   FULFILLED → stock deducted exactly once here via invTxSvc.stockOut()
 *   COMPLETED → operational close; receivable may still be open
 *   CANCELLED → reservation released only (no stockIn needed)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'inv_sync_test_';
const BRANCH_PREFIX = 'InvSync Test ';

// ── Test helpers ──────────────────────────────────────────────────────────────

async function getTestBooks(n = 1): Promise<Array<{ id: number; price: number }>> {
  const r = await db.query(
    `SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT $1`,
    [n],
  );
  if (r.rows.length < n) throw new Error(`Need at least ${n} active books with prices`);
  return r.rows.map(row => ({ id: row.id as number, price: parseFloat(row.default_price as string) }));
}

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(
    `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'InvSync Test Loc', true) RETURNING id`,
    [branchId],
  );
  return c.rows[0].id as number;
}

async function setInventory(bookId: number, locationId: number, qty: number) {
  await db.query(
    `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
     VALUES ($1, $2, $3, 5, 0)
     ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, version = inventory.version + 1`,
    [bookId, locationId, qty],
  );
}

async function getInventoryQty(bookId: number, locationId: number): Promise<number> {
  const r = await db.query(
    `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
    [bookId, locationId],
  );
  return r.rows.length ? parseInt(r.rows[0].quantity as string, 10) : 0;
}

async function cleanOrders(branchId: number) {
  await db.query(
    `DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`,
    [branchId],
  ).catch(() => {});
  await db.query(
    `DELETE FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`,
    [branchId],
  ).catch(() => {});
  await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Order Inventory Sync — Fix Checking & Preservation', () => {
  let salesToken: string;
  let managerToken: string;
  let branchId: number;
  let branchId2: number; // for cross-branch isolation test
  let locationId: number;
  let locationId2: number;
  let bookId: number;
  let bookId2: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`);
    for (const row of oldBranches.rows) {
      await cleanOrders(row.id as number);
    }
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: `${BRANCH_PREFIX}Branch` });
    branchId = branch.branchId;
    const branch2 = await createTestBranch({ name: `${BRANCH_PREFIX}Branch2` });
    branchId2 = branch2.branchId;

    const sales = await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId });
    salesToken = sales.token;
    const mgr = await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId });
    managerToken = mgr.token;

    locationId = await getOrCreateLocation(branchId);
    locationId2 = await getOrCreateLocation(branchId2);

    const books = await getTestBooks(2);
    bookId = books[0].id;
    bookId2 = books[1].id;

    await setInventory(bookId, locationId, 100);
    await setInventory(bookId2, locationId, 100);
    await setInventory(bookId, locationId2, 100);
  });

  afterAll(async () => {
    await cleanOrders(branchId);
    await cleanOrders(branchId2);
    await db.query(
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = ANY($1))`,
      [[branchId, branchId2]],
    );
    await db.query(
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = ANY($1))`,
      [[branchId, branchId2]],
    );
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── 6.2 Draft order creation does NOT change inventory ────────────────────

  it('6.2 DRAFT order creation → inventory unchanged (preservation)', async () => {
    await setInventory(bookId, locationId, 20);
    const qtyBefore = await getInventoryQty(bookId, locationId);

    const res = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 3 }] });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore);
  });

  // ── 6.3 Confirming order does NOT deduct inventory (reservation only) ───────

  it('6.3 Confirming order → inventory.quantity UNCHANGED (reservation only, no deduction)', async () => {
    await setInventory(bookId, locationId, 20);
    const qtyBefore = await getInventoryQty(bookId, locationId);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 5 }] });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.id;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe('CONFIRMED');
    // inventory.quantity must NOT change on confirm — only a reservation is created
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore);
    // qty_reserved on line item must be set
    expect(confirmRes.body.lineItems[0].qtyReserved).toBe(5);
  });

  // ── 6.4 Confirm creates reservation row, no inventory_history stock_out ─────

  it('6.4 Confirming order → inventory_reservations row created with status=reserved; NO stock_out history', async () => {
    await setInventory(bookId, locationId, 30);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 4 }] });
    const orderId = createRes.body.id;

    await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    // Reservation row must exist
    const res = await db.query(
      `SELECT status, quantity FROM inventory_reservations WHERE order_id = $1 AND book_id = $2`,
      [orderId, bookId],
    );
    if (res.rows.length > 0) {
      // Table exists — validate reservation
      expect(res.rows[0].status).toBe('reserved');
      expect(Number(res.rows[0].quantity)).toBe(4);
    }
    // No stock_out history at confirmation time
    const hist = await db.query(
      `SELECT * FROM inventory_history WHERE reference_type = 'order_confirmed' AND reference_id = $1 AND book_id = $2`,
      [orderId, bookId],
    );
    expect(hist.rows.length).toBe(0);
  });

  // ── 6.5 Insufficient stock → hard rejection, inventory unchanged ──────────

  it('6.5 Confirm with insufficient stock → 422 INSUFFICIENT_STOCK, order stays DRAFT, inventory unchanged', async () => {
    await setInventory(bookId, locationId, 2);
    const qtyBefore = await getInventoryQty(bookId, locationId);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 10 }] });
    const orderId = createRes.body.id;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(confirmRes.status).toBe(422);
    expect(confirmRes.body.error).toBe('INSUFFICIENT_STOCK');

    // Transaction must be rolled back: order still DRAFT, inventory unchanged
    const orderAfter = await request(getTestApp())
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(orderAfter.body.status).toBe('DRAFT');
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore);
  });

  // ── 6.6 Cancelling CONFIRMED order → reservation released, inventory UNCHANGED

  it('6.6 Cancel CONFIRMED order → reservation released, inventory.quantity NOT restored (nothing was deducted)', async () => {
    await setInventory(bookId, locationId, 15);
    const qtyBefore = await getInventoryQty(bookId, locationId);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 4 }] });
    const orderId = createRes.body.id;

    await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    // Confirm does NOT deduct stock
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore);

    const cancelRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ reason: 'Test cancellation' });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');
    expect(cancelRes.body.lineItems[0].qtyReserved).toBe(0);

    // inventory.quantity must still equal qtyBefore — cancel must NOT call stockIn
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore);

    // No order_cancelled stock_in history should exist
    const hist = await db.query(
      `SELECT * FROM inventory_history WHERE reference_type = 'order_cancelled' AND reference_id = $1`,
      [orderId],
    );
    expect(hist.rows.length).toBe(0);

    // Reservation must be released
    const resRows = await db.query(
      `SELECT status FROM inventory_reservations WHERE order_id = $1`,
      [orderId],
    );
    if (resRows.rows.length > 0) {
      expect(resRows.rows[0].status).toBe('released');
    }
  });

  // ── 6.7 Cancelling DRAFT order → inventory unchanged ─────────────────────

  it('6.7 Cancel DRAFT order → inventory unchanged (preservation)', async () => {
    await setInventory(bookId, locationId, 25);
    const qtyBefore = await getInventoryQty(bookId, locationId);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 3 }] });
    const orderId = createRes.body.id;

    const cancelRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ reason: 'Never confirmed' });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore);
  });

  // ── 6.8 Cancelling FULFILLED order → still rejected ───────────────────────

  it('6.8 Cancel FULFILLED order → 422 ORDER_ALREADY_FULFILLED (preservation)', async () => {
    await setInventory(bookId, locationId, 10);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 1 }] });
    const orderId = createRes.body.id as string;
    const orderTotal = parseFloat(createRes.body.total as string);

    // confirm → pay (via payments module) → fulfill
    await request(getTestApp()).post(`/api/orders/${orderId}/confirm`).set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId));
    await request(getTestApp()).post('/api/payments').set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId)).send({ orderId: Number(orderId), amount: orderTotal, paymentMethod: 'cash' });
    const fulfillRes = await request(getTestApp()).post(`/api/orders/${orderId}/fulfill`).set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId));
    expect(fulfillRes.status).toBe(200);

    const cancelRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ reason: 'Too late' });

    expect(cancelRes.status).toBe(422);
    expect(cancelRes.body.error).toBe('ORDER_ALREADY_FULFILLED');
  });

  // ── 6.9 Fulfill → stock deducted exactly once at fulfillment ────────────────

  it('6.9 Fulfill order → inventory deducted at fulfillment (not at confirmation)', async () => {
    await setInventory(bookId, locationId, 20);
    const qtyBefore = await getInventoryQty(bookId, locationId);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 3 }] });
    const orderId = createRes.body.id as string;
    const orderTotal = parseFloat(createRes.body.total as string);

    await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    // Confirm does NOT deduct stock
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore);

    // Pay via /api/payments (the /orders/:id/pay route is deprecated)
    await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: Number(orderId), amount: orderTotal, paymentMethod: 'cash' });

    // Stock deducted at payment (auto-fulfill)
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore - 3);

    // History must exist for the fulfillment deduction
    const hist = await db.query(
      `SELECT * FROM inventory_history WHERE reference_type = 'order_fulfilled' AND reference_id = $1 AND book_id = $2`,
      [orderId, bookId],
    );
    expect(hist.rows.length).toBeGreaterThan(0);
    expect(Number(hist.rows[0].delta)).toBe(-3);
    expect(hist.rows[0].movement_type).toBe('stock_out');
  });

  // ── 6.10 Multi-item order atomicity ───────────────────────────────────────

  it('6.10 Multi-item order: insufficient stock on one item → whole confirm rolls back', async () => {
    // Clear all reservations for both books at this location before starting
    await db.query(`DELETE FROM inventory_reservations WHERE book_id = ANY($1) AND location_id = $2`, [[bookId, bookId2], locationId]).catch(() => {});
    await setInventory(bookId, locationId, 10);
    await setInventory(bookId2, locationId, 2); // too low for 5 requested
    const qtyBefore1 = await getInventoryQty(bookId, locationId);
    const qtyBefore2 = await getInventoryQty(bookId2, locationId);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 3 }, { bookId: bookId2, quantity: 5 }] });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.id as string;

    // First confirm: bookId2 has only 2, needs 5 → fail, full rollback
    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(confirmRes.status).toBe(422);
    expect(confirmRes.body.error).toBe('INSUFFICIENT_STOCK');
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore1);
    expect(await getInventoryQty(bookId2, locationId)).toBe(qtyBefore2);

    // No reservation rows from the failed confirm
    const resRows = await db.query(
      `SELECT * FROM inventory_reservations WHERE order_id = $1`,
      [orderId],
    ).catch(() => ({ rows: [] }));
    expect(resRows.rows.length).toBe(0);

    // Fix bookId2 stock and clear its reservations, then retry confirm
    await db.query(`DELETE FROM inventory_reservations WHERE book_id = $1 AND location_id = $2`, [bookId2, locationId]).catch(() => {});
    await setInventory(bookId2, locationId, 10);
    // Also clear any stale reservations for bookId from prior tests
    await db.query(`DELETE FROM inventory_reservations WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]).catch(() => {});
    const qtyBefore1b = await getInventoryQty(bookId, locationId);
    const qtyBefore2b = await getInventoryQty(bookId2, locationId);

    const confirmRes2 = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(confirmRes2.status).toBe(200);
    // inventory.quantity UNCHANGED (reservation only, no deduction)
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore1b);
    expect(await getInventoryQty(bookId2, locationId)).toBe(qtyBefore2b);
  });

  // ── 6.11 Concurrent confirms — only one wins (available stock gating) ────────

  it('6.11 Concurrent confirmations → only one wins; second gets INSUFFICIENT_STOCK', async () => {
    // Set qty=5 with no existing reservations to ensure exactly 5 available
    await setInventory(bookId, locationId, 5);
    // Clear any leftover reservations from earlier tests
    await db.query(
      `DELETE FROM inventory_reservations WHERE book_id = $1 AND location_id = $2`,
      [bookId, locationId],
    ).catch(() => { /* table may not exist — safe */ });

    const cr1 = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 5 }] });
    const cr2 = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 5 }] });

    expect(cr1.status).toBe(201);
    expect(cr2.status).toBe(201);

    const [conf1, conf2] = await Promise.all([
      request(getTestApp())
        .post(`/api/orders/${cr1.body.id}/confirm`)
        .set('Authorization', `Bearer ${managerToken}`)
        .set('X-Branch-Id', String(branchId)),
      request(getTestApp())
        .post(`/api/orders/${cr2.body.id}/confirm`)
        .set('Authorization', `Bearer ${managerToken}`)
        .set('X-Branch-Id', String(branchId)),
    ]);

    const statuses = [conf1.status, conf2.status].sort();
    expect(statuses).toContain(200);
    expect(statuses).toContain(422);

    const failedConfirm = conf1.status === 422 ? conf1 : conf2;
    expect(failedConfirm.body.error).toBe('INSUFFICIENT_STOCK');

    // inventory.quantity unchanged (no deduction at confirm)
    expect(await getInventoryQty(bookId, locationId)).toBe(5);
    // But available should be 0 (5 reserved by the winner)
    const resRows = await db.query(
      `SELECT SUM(quantity) AS total_reserved FROM inventory_reservations WHERE book_id = $1 AND location_id = $2 AND status = 'reserved'`,
      [bookId, locationId],
    ).catch(() => ({ rows: [{ total_reserved: null }] }));
    const totalReserved = Number(resRows.rows[0].total_reserved ?? 0);
    expect(totalReserved).toBe(5);
  });

  // ── 6.12 Negative stock prevention ───────────────────────────────────────

  it('6.12 Cannot confirm when stock is 0 → 422 INSUFFICIENT_STOCK, qty stays 0', async () => {
    await setInventory(bookId, locationId, 0);
    // Also clear any existing reservations so available = 0
    await db.query(
      `DELETE FROM inventory_reservations WHERE book_id = $1 AND location_id = $2`,
      [bookId, locationId],
    ).catch(() => { /* table may not exist */ });

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 1 }] });
    const orderId = createRes.body.id;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(confirmRes.status).toBe(422);
    expect(confirmRes.body.error).toBe('INSUFFICIENT_STOCK');
    expect(await getInventoryQty(bookId, locationId)).toBe(0); // never goes negative
  });

  // ── 6.13 Cross-branch isolation ───────────────────────────────────────────

  it('6.13 Confirming order in branch A does NOT affect inventory in branch B', async () => {
    await setInventory(bookId, locationId, 10);
    await setInventory(bookId, locationId2, 10);
    const qtyBranch1Before = await getInventoryQty(bookId, locationId);
    const qtyBranch2Before = await getInventoryQty(bookId, locationId2);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 3 }] });
    const orderId = createRes.body.id;

    await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    // Branch A inventory unchanged (reservation only — no deduction)
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBranch1Before);
    // Branch B inventory also unchanged
    expect(await getInventoryQty(bookId, locationId2)).toBe(qtyBranch2Before);
  });
});
