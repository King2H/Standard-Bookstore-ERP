import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'ord_test_';
const BRANCH_PREFIX = 'Orders Test ';

async function getTestBook(): Promise<{ id: number; price: number }> {
  const r = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 1`);
  if (!r.rows.length) throw new Error('No active books with price');
  return { id: r.rows[0].id as number, price: parseFloat(r.rows[0].default_price as string) };
}

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Orders Test Loc', true) RETURNING id`, [branchId]);
  return c.rows[0].id as number;
}

async function ensureInventory(bookId: number, locationId: number, qty = 50) {
  await db.query(
    `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
     VALUES ($1, $2, $3, 5, 0)
     ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, version = 0`,
    [bookId, locationId, qty],
  );
}

async function cleanOrders(branchId: number) {
  await db.query(`DELETE FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]);
}

describe('Orders — Lifecycle', () => {
  let salesToken: string;
  let managerToken: string;
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let bookPrice: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE 'Orders Test %'`);
    for (const row of oldBranches.rows) {
      await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [row.id]);
      await db.query(`DELETE FROM orders WHERE branch_id = $1`, [row.id]);
    }
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Orders Test Branch' });
    branchId = branch.branchId;
    const sales = await createTestStaff({ username: 'ord_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;
    const mgr = await createTestStaff({ username: 'ord_test_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;

    locationId = await getOrCreateLocation(branchId);
    const book = await getTestBook();
    bookId = book.id;
    bookPrice = book.price;
    await ensureInventory(bookId, locationId, 50);
  });

  afterAll(async () => {
    await cleanOrders(branchId);
    await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── 1. Create order ─────────────────────────────────────────────────────────

  it('1. Create order → status=Pending, correct totals, ETB currency', async () => {
    const res = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, channel: 'in_store', items: [{ bookId, quantity: 2 }] });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.currency).toBe('ETB');
    expect(res.body.orderNumber).toMatch(/^ORD-\d{8}-\d{4}$/);
    expect(Number(res.body.subtotal)).toBeCloseTo(bookPrice * 2, 1);
    expect(res.body.lineItems).toHaveLength(1);
    expect(res.body.lineItems[0].qtyReserved).toBe(0);
  });

  // ── 2. Confirm order → stock reserved ──────────────────────────────────────

  it('2. Confirm order → stock reserved, status=Confirmed', async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 3 }] });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.id;

    const invBefore = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const qtyBefore2 = invBefore.rows[0].quantity as number;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe('CONFIRMED');
    // qty_reserved is tracked on order_line_items, not inventory
    expect(confirmRes.body.lineItems[0].qtyReserved).toBe(3);
  });

  // ── 3. Fulfill order → inventory decremented ───────────────────────────────

  it('3. Fulfill order → inventory decremented, status=Fulfilled', async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 2 }] });
    const orderId = createRes.body.id;

    await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    const invBefore = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const qtyBefore = invBefore.rows[0].quantity as number;

    const fulfillRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(fulfillRes.status).toBe(200);
    expect(fulfillRes.body.status).toBe('FULFILLED');

    const invAfter = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invAfter.rows[0].quantity).toBe(qtyBefore - 2);
  });

  // ── 4. Cancel order → reserved stock released ──────────────────────────────

  it('4. Cancel confirmed order → reserved stock released', async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 2 }] });
    const orderId = createRes.body.id;

    await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    const cancelRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ reason: 'Customer changed mind' });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');
    // qty_reserved released on order_line_items
    expect(cancelRes.body.lineItems[0].qtyReserved).toBe(0);
  });

  // ── 5. Cannot cancel fulfilled order ───────────────────────────────────────

  it('5. Cannot cancel fulfilled order → 422 ORDER_ALREADY_FULFILLED', async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 1 }] });
    const orderId = createRes.body.id;

    await request(getTestApp()).post(`/api/orders/${orderId}/confirm`).set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId));
    await request(getTestApp()).post(`/api/orders/${orderId}/fulfill`).set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId));

    const cancelRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ reason: 'Too late' });

    expect(cancelRes.status).toBe(422);
    expect(cancelRes.body.error).toBe('ORDER_ALREADY_FULFILLED');
  });

  // ── 6. Invalid state transition → 422 ──────────────────────────────────────

  it('6. Invalid state transition (fulfill Pending) → 422 INVALID_STATE', async () => {
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 1 }] });
    const orderId = createRes.body.id;

    const res = await request(getTestApp())
      .post(`/api/orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INVALID_STATE');
  });

  // ── 7. Backordered when insufficient stock ─────────────────────────────────

  it('7. Confirm with insufficient stock → line item backordered', async () => {
    await db.query(`UPDATE inventory SET quantity = 0, version = 0 WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 5 }] });
    const orderId = createRes.body.id;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe('CONFIRMED');
    expect(confirmRes.body.lineItems[0].isBackordered).toBe(true);
    expect(confirmRes.body.lineItems[0].qtyReserved).toBe(0);

    await ensureInventory(bookId, locationId, 50);
  });

  // ── 8. GET /api/orders list ─────────────────────────────────────────────────

  it('8. GET /api/orders → returns paginated list', async () => {
    const res = await request(getTestApp())
      .get(`/api/orders?branchId=${branchId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items[0].currency).toBe('ETB');
  });
});
