import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'pay_test_';
const BRANCH_PREFIX = 'Payments Test ';

async function getTestBook(): Promise<{ id: number; price: number }> {
  const r = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 1`);
  if (!r.rows.length) throw new Error('No active books with price');
  return { id: r.rows[0].id as number, price: parseFloat(r.rows[0].default_price as string) };
}

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Pay Test Loc', true) RETURNING id`, [branchId]);
  return c.rows[0].id as number;
}

async function createTestCustomer(branchId: number): Promise<number> {
  const code = `PAY-TEST-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const r = await db.query(
    `INSERT INTO customers (branch_id, customer_code, full_name, is_active, created_at)
     VALUES ($1, $2, 'Payments Test Customer', true, now()) RETURNING id`,
    [branchId, code],
  );
  return r.rows[0].id as number;
}

// Manual payment collection via POST /api/payments is only valid for
// credit_sale orders — cash_sale orders are paid automatically at
// confirmation and POST /api/payments rejects them with
// CASH_ORDER_ALREADY_PAID (see payments.service.ts "Bug 2" guard). These
// tests exercise the payment-collection endpoint itself, so they need a
// credit_sale order (which requires a customer) rather than the default
// cash_sale.
async function createTestOrder(token: string, branchId: number, locationId: number, bookId: number, customerId: number): Promise<{ id: string; total: number }> {
  const res = await request(getTestApp())
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Branch-Id', String(branchId))
    .send({ locationId, channel: 'in_store', saleType: 'credit_sale', customerId, items: [{ bookId, quantity: 2 }] });
  if (res.status !== 201) throw new Error(`Order creation failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.id, total: Number(res.body.total) };
}

async function cleanPayments(branchId: number) {
  await db.query(`DELETE FROM receivables WHERE branch_id = $1`, [branchId]);
  await db.query(`DELETE FROM order_refunds WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]);
  await db.query(`DELETE FROM customers WHERE branch_id = $1 AND full_name = 'Payments Test Customer'`, [branchId]);
}

describe('Payments — Order Payment Management', () => {
  let salesToken: string;
  let managerToken: string;
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let customerId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE 'Payments Test %'`);
    for (const row of oldBranches.rows) await cleanPayments(row.id as number);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Payments Test Branch' });
    branchId = branch.branchId;
    const sales = await createTestStaff({ username: 'pay_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;
    const mgr = await createTestStaff({ username: 'pay_test_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;

    locationId = await getOrCreateLocation(branchId);
    const book = await getTestBook();
    bookId = book.id;
    customerId = await createTestCustomer(branchId);
  });

  afterAll(async () => {
    await cleanPayments(branchId);
    await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── 1. Full payment → order payment_status = paid ──────────────────────────

  it('1. Full payment → order payment_status = paid', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);

    const res = await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: order.total, paymentMethod: 'cash' });

    expect(res.status).toBe(201);
    expect(res.body.paymentReference).toMatch(/^PAY-\d{8}-\d{4}$/);
    expect(res.body.status).toBe('success');
    expect(res.body.currency).toBe('ETB');
    expect(Number(res.body.amount)).toBeCloseTo(order.total, 2);

    // Order payment_status should be 'paid'
    const orderRes = await db.query(`SELECT payment_status FROM orders WHERE id = $1`, [order.id]);
    expect(orderRes.rows[0].payment_status).toBe('paid');
  });

  // ── 2. Partial payment → order payment_status = partial ───────────────────

  it('2. Partial payment → order payment_status = partial', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);
    const partialAmount = parseFloat((order.total / 2).toFixed(2));

    const res = await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: partialAmount, paymentMethod: 'cash' });

    expect(res.status).toBe(201);

    const orderRes = await db.query(`SELECT payment_status FROM orders WHERE id = $1`, [order.id]);
    expect(orderRes.rows[0].payment_status).toBe('partial');
  });

  // ── 3. Payment exceeds order total → 422 ──────────────────────────────────

  it('3. Payment exceeds order total → 422 EXCEEDS_ORDER_TOTAL', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);

    const res = await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: order.total + 1000, paymentMethod: 'cash' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('EXCEEDS_ORDER_TOTAL');
  });

  // ── 4. Refund → payment status updated ────────────────────────────────────

  it('4. Full refund → payment status = refunded, order = refunded', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);

    const payRes = await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: order.total, paymentMethod: 'cash' });
    expect(payRes.status).toBe(201);
    const paymentId = payRes.body.id;

    const refundRes = await request(getTestApp())
      .post(`/api/payments/${paymentId}/refund`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ refundAmount: order.total, reason: 'Customer returned all items' });

    expect(refundRes.status).toBe(201);
    expect(Number(refundRes.body.refundAmount)).toBeCloseTo(order.total, 2);

    // Payment status should be 'refunded'
    const payCheck = await db.query(`SELECT status FROM order_payments WHERE id = $1`, [paymentId]);
    expect(payCheck.rows[0].status).toBe('refunded');

    // Order payment_status should be 'refunded'
    const orderRes = await db.query(`SELECT payment_status FROM orders WHERE id = $1`, [order.id]);
    expect(orderRes.rows[0].payment_status).toBe('refunded');
  });

  // ── 5. Refund exceeds payment → 422 ───────────────────────────────────────

  it('5. Refund exceeds payment amount → 422 EXCEEDS_PAYMENT_AMOUNT', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);

    const payRes = await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: order.total, paymentMethod: 'cash' });
    const paymentId = payRes.body.id;

    const refundRes = await request(getTestApp())
      .post(`/api/payments/${paymentId}/refund`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ refundAmount: order.total + 500, reason: 'Too much' });

    expect(refundRes.status).toBe(422);
    expect(refundRes.body.error).toBe('EXCEEDS_PAYMENT_AMOUNT');
  });

  // ── 6. GET /api/orders/:id/balance ────────────────────────────────────────

  it('6. GET /api/orders/:id/balance → correct outstanding', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);
    const partialAmount = parseFloat((order.total * 0.6).toFixed(2));

    await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: partialAmount, paymentMethod: 'mobile' });

    const balRes = await request(getTestApp())
      .get(`/api/orders/${order.id}/balance`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(balRes.status).toBe(200);
    expect(Number(balRes.body.orderTotal)).toBeCloseTo(order.total, 2);
    expect(Number(balRes.body.totalPaid)).toBeCloseTo(partialAmount, 2);
    expect(Number(balRes.body.outstanding)).toBeCloseTo(order.total - partialAmount, 2);
    expect(balRes.body.paymentStatus).toBe('partial');
  });

  // ── 7. GET /api/orders/:id/payments ───────────────────────────────────────

  it('7. GET /api/orders/:id/payments → lists payments for order', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);

    await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: order.total, paymentMethod: 'mobile' });

    const listRes = await request(getTestApp())
      .get(`/api/orders/${order.id}/payments`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0].paymentMethod).toBe('mobile');
    expect(listRes.body.items[0].currency).toBe('ETB');
  });

  // ── 8. Split payment (two methods) ────────────────────────────────────────

  it('8. Split payment (cash + mobile) → order fully paid', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);
    const half = parseFloat((order.total / 2).toFixed(2));
    const remainder = parseFloat((order.total - half).toFixed(2));

    await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: half, paymentMethod: 'cash' });

    const res2 = await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: remainder, paymentMethod: 'mobile' });

    expect(res2.status).toBe(201);

    const orderRes = await db.query(`SELECT payment_status FROM orders WHERE id = $1`, [order.id]);
    expect(orderRes.rows[0].payment_status).toBe('paid');
  });
});
