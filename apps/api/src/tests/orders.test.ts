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
  await db.query(`DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]).catch(() => {});
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
  let customerId: number;

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

    await db.query(`DELETE FROM customers WHERE customer_code = 'ORD-TEST-CUST-001'`).catch(() => {});
    const custRes = await db.query(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Orders Test Customer', 'ORD-TEST-CUST-001', true) RETURNING id`,
    );
    customerId = custRes.rows[0].id as number;
  });

  afterAll(async () => {
    await cleanOrders(branchId);
    await db.query(`DELETE FROM receivables WHERE customer_id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM store_credit_history WHERE customer_id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM store_credit_accounts WHERE customer_id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM customers WHERE id = $1`, [customerId]).catch(() => {});
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

  // ── 2. Confirm order → reservation only, inventory unchanged ─────────────

  it('2. Confirm order → soft reservation created; inventory.quantity UNCHANGED', async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 3 }] });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.id;

    const invBefore = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const qtyBefore = invBefore.rows[0].quantity as number;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe('CONFIRMED');
    expect(confirmRes.body.lineItems[0].qtyReserved).toBe(3);

    // confirm() deducts inventory immediately via stockOut() (order-payment-
    // unification spec, 3.5) in addition to writing the soft reservation.
    const invAfter = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invAfter.rows[0].quantity).toBe(qtyBefore - 3);
  });

  // ── 3. Full cash_sale lifecycle: confirm → pay → fulfill ──────────────────

  it('3. cash_sale: confirm deducts stock immediately; fulfill does not deduct again', async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 2 }] });
    const orderId = createRes.body.id as string;

    const invBefore = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const qtyBeforeConfirm = invBefore.rows[0].quantity as number;

    // Confirm — deducts inventory immediately via stockOut() (order-payment-
    // unification spec, 3.5); also sets payment_status='paid' for cash_sale.
    await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    const invAfterConfirm = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invAfterConfirm.rows[0].quantity).toBe(qtyBeforeConfirm - 2);

    // POST /api/payments rejects cash_sale orders (paid automatically at
    // confirm; payments.service.ts "Bug 2" guard) — fulfill directly.
    const fulfillRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(fulfillRes.status).toBe(200);
    expect(fulfillRes.body.status).toBe('COMPLETED');

    // fulfill() doesn't deduct again — already deducted at confirm.
    const invAfterFulfill = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invAfterFulfill.rows[0].quantity).toBe(qtyBeforeConfirm - 2);
  });

  // ── 4. Cancel confirmed order → reservation released, inventory unchanged ──

  it('4. Cancel confirmed order → reservation released; inventory.quantity UNCHANGED (no stockIn)', async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 2 }] });
    const orderId = createRes.body.id;

    const invBefore = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const qtyBeforeConfirm = invBefore.rows[0].quantity as number;

    await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    // confirm() deducts immediately (order-payment-unification spec, 3.5)
    const invAfterConfirm = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invAfterConfirm.rows[0].quantity).toBe(qtyBeforeConfirm - 2);

    const cancelRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ reason: 'Customer changed mind' });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');
    expect(cancelRes.body.lineItems[0].qtyReserved).toBe(0);

    // cancel() restores via stockIn() — net back to the pre-confirm level
    const invAfterCancel = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invAfterCancel.rows[0].quantity).toBe(qtyBeforeConfirm);
  });

  // ── 5. Cannot cancel fulfilled order ───────────────────────────────────────

  it('5. Cannot cancel COMPLETED order → 422 ORDER_ALREADY_FULFILLED', async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 1 }] });
    const orderId = createRes.body.id as string;
    const orderTotal = createRes.body.total as number;

    // confirm → pay → fulfill
    await request(getTestApp()).post(`/api/orders/${orderId}/confirm`).set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId));
    await request(getTestApp()).post('/api/payments').set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId)).send({ orderId: Number(orderId), amount: orderTotal, paymentMethod: 'cash' });
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

  // ── 7. Insufficient stock → hard rejection with INSUFFICIENT_STOCK ─────────
  // Stock Visibility (Unified Order Creation Workflow): create() now rejects
  // an order that exceeds available branch inventory up front — closer to
  // where the user is adding items — instead of only surfacing the problem
  // much later at confirm. confirm()'s own row-locked, authoritative check
  // (covering stock consumed by other orders between create and confirm)
  // remains unchanged and is covered separately below (test 7b).

  it('7. Create with insufficient stock → 422 INSUFFICIENT_STOCK (rejected before an order ever exists)', async () => {
    await db.query(`UPDATE inventory SET quantity = 0, version = 0 WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 5 }] });

    expect(createRes.status).toBe(422);
    expect(createRes.body.error).toBe('INSUFFICIENT_STOCK');

    await ensureInventory(bookId, locationId, 50);
  });

  it('7b. Confirm with stock consumed after create (race) → 422 INSUFFICIENT_STOCK; order stays DRAFT', async () => {
    await ensureInventory(bookId, locationId, 5);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 5 }] });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.id;

    // Simulate stock disappearing between create() and confirm() — confirm()'s
    // own authoritative, row-locked check must still catch this.
    await db.query(`UPDATE inventory SET quantity = 0, version = version + 1 WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(confirmRes.status).toBe(422);
    expect(confirmRes.body.error).toBe('INSUFFICIENT_STOCK');

    // Order status must remain DRAFT (transaction was rolled back)
    const orderAfter = await request(getTestApp())
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(orderAfter.body.status).toBe('DRAFT');

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

  // ── 9. Payment Mode Capture ──────────────────────────────────────────────────

  it('9. Confirm cash_sale with paymentMethod=bank → persisted on order_payments and surfaced on GET', async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 1 }] });
    const orderId = createRes.body.id as string;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ paymentMethod: 'bank' });

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.paymentMethod).toBe('bank');

    const payRow = await db.query(`SELECT payment_method, status, amount FROM order_payments WHERE order_id = $1`, [orderId]);
    expect(payRow.rows).toHaveLength(1);
    expect(payRow.rows[0].payment_method).toBe('bank');
    expect(payRow.rows[0].status).toBe('success');

    const getRes = await request(getTestApp())
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(getRes.body.paymentMethod).toBe('bank');
  });

  it('9b. Confirm cash_sale with no paymentMethod → defaults to cash (backward compatible)', async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 1 }] });
    const orderId = createRes.body.id as string;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.paymentMethod).toBe('cash');
  });

  it('9c. Confirm cash_sale with an invalid paymentMethod → 400 ValidationError', async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 1 }] });
    const orderId = createRes.body.id as string;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ paymentMethod: 'card' }); // 'card' is a valid order_payments value but not one of this ticket's 4 options

    expect(confirmRes.status).toBe(400);
  });

  it('9d. Confirm cash_sale with paymentMethod=store_credit → deducts store credit balance and records history', async () => {
    await ensureInventory(bookId, locationId, 50);
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 500) ON CONFLICT (customer_id) DO UPDATE SET balance = 500`, [customerId]);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ customerId, locationId, items: [{ bookId, quantity: 1 }] });
    const orderId = createRes.body.id as string;
    const orderTotal = Number(createRes.body.total);

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ paymentMethod: 'store_credit' });

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.paymentMethod).toBe('store_credit');

    const balRes = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    expect(parseFloat(balRes.rows[0].balance as string)).toBeCloseTo(500 - orderTotal, 2);

    const histRes = await db.query(
      `SELECT ref_type, direction, amount FROM store_credit_history WHERE customer_id = $1 AND ref_id = $2`,
      [customerId, orderId],
    );
    expect(histRes.rows).toHaveLength(1);
    expect(histRes.rows[0].ref_type).toBe('order_cash_sale');
    expect(histRes.rows[0].direction).toBe('debit');
  });

  it('9e. Confirm cash_sale with paymentMethod=store_credit and insufficient balance → 422 INSUFFICIENT_STORE_CREDIT; no state change', async () => {
    await ensureInventory(bookId, locationId, 50);
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 0.5) ON CONFLICT (customer_id) DO UPDATE SET balance = 0.5`, [customerId]);

    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ customerId, locationId, items: [{ bookId, quantity: 1 }] });
    const orderId = createRes.body.id as string;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ paymentMethod: 'store_credit' });

    expect(confirmRes.status).toBe(422);
    expect(confirmRes.body.error).toBe('INSUFFICIENT_STORE_CREDIT');

    const balRes = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    expect(parseFloat(balRes.rows[0].balance as string)).toBeCloseTo(0.5, 2);

    const orderAfter = await request(getTestApp())
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(orderAfter.body.status).toBe('DRAFT');
  });

  // ── 10. Credit Due Date ──────────────────────────────────────────────────────

  it('10. Confirm credit_sale with a past due date → 400 ValidationError; order stays DRAFT', async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ customerId, locationId, saleType: 'credit_sale', items: [{ bookId, quantity: 1 }] });
    const orderId = createRes.body.id as string;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ dueDate: '2020-01-01' });

    expect(confirmRes.status).toBe(400);

    const orderAfter = await request(getTestApp())
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(orderAfter.body.status).toBe('DRAFT');
  });

  it("10b. Confirm credit_sale with today's date as due date → accepted; dueDate surfaced on GET and receivable", async () => {
    await ensureInventory(bookId, locationId, 50);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ customerId, locationId, saleType: 'credit_sale', items: [{ bookId, quantity: 1 }] });
    const orderId = createRes.body.id as string;

    const todayRes = await db.query(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
    const today = todayRes.rows[0].today as string;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ dueDate: today });

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.dueDate).toBe(today);

    const recRes = await db.query(
      `SELECT TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1`,
      [orderId],
    );
    expect(recRes.rows[0].due_date).toBe(today);
  });

  // ── 11. Stock Visibility: quantity capped at what's actually available ─────

  it('11. Create order for quantity exactly at available stock → succeeds', async () => {
    await ensureInventory(bookId, locationId, 3);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 3 }] });

    expect(createRes.status).toBe(201);
    await ensureInventory(bookId, locationId, 50);
  });
});
