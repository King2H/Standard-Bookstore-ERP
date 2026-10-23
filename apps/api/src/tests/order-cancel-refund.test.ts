import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #167: cancelling an order that took payments left the money with the shop,
// with nothing saying it was owed back. Now the cancel gives it back in the
// same transaction: the way it was paid, or as store credit for the named
// customer (decision 1a), by the roles that refund (2a). A refund on an order
// cancelled before this no longer brings its debt back.

const STAFF_PREFIX = 'ordcancel_test_';
const BRANCH_PREFIX = 'Ord Cancel ';
const CUSTOMER_CODE = 'ORDCANCEL-001';

describe('Cancelling an order that took payments (#167)', () => {
  let branchId: number;
  let locationId: number;
  let customerId: number;
  let bookId: number;
  let price: number;
  let sales: string;
  let manager: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = manager) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));

  async function order(saleType: 'cash_sale' | 'credit_sale', opts: { customer?: boolean } = {}) {
    const res = await as(api().post('/api/v1/orders'), sales).send({
      locationId, saleType, ...(opts.customer !== false && { customerId }), items: [{ bookId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    return String(res.body.id);
  }
  const confirm = (id: string, body: Record<string, unknown>) => as(api().post(`/api/v1/orders/${id}/confirm`)).send(body);
  const pay = (id: string, amount: number, method = 'cash') =>
    as(api().post('/api/v1/payments'), sales).send({ orderId: Number(id), amount, paymentMethod: method });
  const cancel = (id: string, body: Record<string, unknown>, token = manager) =>
    as(api().post(`/api/v1/orders/${id}/cancel`), token).send({ reason: 'Customer withdrew', ...body });
  const one = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0];
  const storeCredit = async () => Number((await one(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId])).balance);
  const money = async (id: string) => one(
    `SELECT o.status, o.payment_status,
       (SELECT COALESCE(SUM(amount), 0) FROM order_payments WHERE order_id = o.id)::text AS paid,
       (SELECT COALESCE(SUM(refund_amount), 0) FROM order_refunds WHERE order_id = o.id)::text AS refunded,
       (SELECT string_agg(DISTINCT method, ',') FROM order_refunds WHERE order_id = o.id) AS refunded_as,
       (SELECT string_agg(status, ',') FROM order_payments WHERE order_id = o.id) AS payments,
       (SELECT r.status || ' ' || r.outstanding_amount FROM receivables r WHERE r.source_type = 'order_credit_sale' AND r.source_entity_id = o.id) AS debt
     FROM orders o WHERE o.id = $1`,
    [id],
  );

  async function cleanUp() {
    const orders = `SELECT o.id FROM orders o JOIN branches b ON b.id = o.branch_id WHERE b.name LIKE '${BRANCH_PREFIX}%'`;
    const customer = `SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`;
    for (const statement of [
      `DELETE FROM order_refunds WHERE order_id IN (${orders})`,
      `WITH refunds AS (DELETE FROM order_refunds WHERE payment_id IN (SELECT id FROM order_payments WHERE order_id IN (${orders}))) DELETE FROM order_payments WHERE order_id IN (${orders})`,
      `DELETE FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id IN (${orders})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${orders})`,
      `DELETE FROM order_line_items WHERE order_id IN (${orders})`,
      `DELETE FROM orders WHERE id IN (${orders})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT l.id FROM locations l JOIN branches b ON b.id = l.branch_id WHERE b.name LIKE '${BRANCH_PREFIX}%')`,
      `DELETE FROM inventory WHERE location_id IN (SELECT l.id FROM locations l JOIN branches b ON b.id = l.branch_id WHERE b.name LIKE '${BRANCH_PREFIX}%')`,
      `DELETE FROM store_credit_history WHERE customer_id IN (${customer})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customer})`,
      `DELETE FROM loyalty_history WHERE customer_id IN (${customer})`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (${customer})`,
      `DELETE FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    locationId = (await one(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Ord Cancel Loc', true) RETURNING id`, [branchId],
    )).id;
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`, []);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, 100, 5, 0, 4)`, [bookId, locationId]);
    customerId = (await one(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Ord Cancel Customer', $1, true) RETURNING id`, [CUSTOMER_CODE],
    )).id;
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 100)`, [customerId]);
  });

  afterAll(cleanUp);

  it('gives the money back the way it was paid, in the same transaction (was: kept as taken, nothing owed back)', async () => {
    const id = await order('cash_sale');
    expect((await confirm(id, { paymentMethod: 'cash' })).status).toBe(200);
    const res = await cancel(id, { refundTo: 'original' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED', paymentStatus: 'refunded', amountPaid: 0 });
    expect(await money(id)).toMatchObject({ paid: price.toFixed(2), refunded: price.toFixed(2), refunded_as: 'cash', payments: 'refunded' });
  });

  it('gives a payment by store credit back to the customer\'s store credit, and cash back as cash', async () => {
    const id = await order('credit_sale');
    expect((await confirm(id, { dueDate: '2099-12-31' })).status).toBe(200);
    expect((await pay(id, 5, 'store_credit')).status).toBe(201);
    expect((await pay(id, 3)).status).toBe(201);
    const before = await storeCredit();
    expect((await cancel(id, { refundTo: 'original' })).status).toBe(200);
    expect(await storeCredit()).toBeCloseTo(before + 5, 2);
    expect(await money(id)).toMatchObject({ refunded: '8.00', refunded_as: 'cash,store_credit', debt: 'Cancelled 0.00' });
  });

  it('puts the money on the named customer\'s store credit when asked', async () => {
    const id = await order('credit_sale');
    expect((await confirm(id, { dueDate: '2099-12-31' })).status).toBe(200);
    expect((await pay(id, 10)).status).toBe(201);
    const before = await storeCredit();
    const res = await cancel(id, { refundTo: 'store_credit' });
    expect(res.status).toBe(200);
    expect(await storeCredit()).toBeCloseTo(before + 10, 2);
    expect(await money(id)).toMatchObject({ refunded: '10.00', refunded_as: 'store_credit', debt: 'Cancelled 0.00', payment_status: 'unpaid' });
  });

  it('asks how the money goes back, and refuses store credit without a customer; nothing changes', async () => {
    const id = await order('cash_sale', { customer: false });
    expect((await confirm(id, { paymentMethod: 'cash' })).status).toBe(200);
    const missing = await cancel(id, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('VALIDATION_ERROR');
    const noCustomer = await cancel(id, { refundTo: 'store_credit' });
    expect(noCustomer.status).toBe(422);
    expect(noCustomer.body.error).toBe('CREDIT_REQUIRES_CUSTOMER');
    expect(await money(id)).toMatchObject({ status: 'CONFIRMED', refunded: '0' });
  });

  it('leaves an order that took payments to the roles that refund (was: Sales cancelled it and could not refund)', async () => {
    const paid = await order('cash_sale');
    expect((await confirm(paid, { paymentMethod: 'cash' })).status).toBe(200);
    const view = await as(api().get(`/api/v1/orders/${paid}`), sales);
    expect(view.body.allowedActions).not.toContain('cancel');
    expect(view.body.amountPaid).toBe(price);
    expect((await cancel(paid, { refundTo: 'original' }, sales)).status).toBe(403);
    expect((await money(paid)).status).toBe('CONFIRMED');

    const unpaid = await order('credit_sale');
    expect((await confirm(unpaid, { dueDate: '2099-12-31' })).status).toBe(200);
    expect((await as(api().get(`/api/v1/orders/${unpaid}`), sales)).body.allowedActions).toContain('cancel');
    expect((await cancel(unpaid, {}, sales)).status).toBe(200);
  });

  it('shows the money in and back out in the payments report and ledger (was: the refund out with no money in, net negative)', async () => {
    const id = await order('cash_sale');
    expect((await confirm(id, { paymentMethod: 'cash' })).status).toBe(200);
    const cancelled = await cancel(id, { refundTo: 'original' });
    expect(cancelled.status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    const ledger = await as(api().get(`/api/v1/reports/payments-ledger?dateFrom=${today}&dateTo=${today}`));
    const rows = ledger.body.rows.filter((r: { referenceNo: string }) => r.referenceNo === cancelled.body.orderNumber);
    expect(rows.map((r: { amount: number; direction: string }) => [r.direction, r.amount]).sort()).toEqual([['IN', price], ['OUT', price]]);

    const report = await as(api().get(`/api/v1/reports/payments?dateFrom=${today}&dateTo=${today}`));
    const moved = await one(
      `SELECT (SELECT COALESCE(SUM(p.amount), 0) FROM order_payments p JOIN orders o ON o.id = p.order_id WHERE o.branch_id = $1) AS paid,
              (SELECT COALESCE(SUM(r.refund_amount), 0) FROM order_refunds r JOIN orders o ON o.id = r.order_id WHERE o.branch_id = $1) AS refunded`,
      [branchId],
    );
    expect(report.body.summary).toMatchObject({ totalCollected: Number(moved.paid), totalRefunded: Number(moved.refunded) });
  });

  it('does not bring back the debt of an order cancelled before, when its payment is refunded (was: owed in full again)', async () => {
    const id = await order('credit_sale');
    expect((await confirm(id, { dueDate: '2099-12-31' })).status).toBe(200);
    const payment = (await pay(id, 10)).body;
    // As an order cancelled before this change was left: cancelled, its debt cancelled, the payment kept.
    await db.query(`UPDATE orders SET status = 'CANCELLED', cancel_reason = 'before #167' WHERE id = $1`, [id]);
    await db.query(
      `UPDATE receivables SET status = 'Cancelled', cancelled_amount = outstanding_amount, outstanding_amount = 0, cancelled_at = now()
       WHERE source_type = 'order_credit_sale' AND source_entity_id = $1`,
      [id],
    );
    const res = await as(api().post(`/api/v1/payments/${payment.id}/refund`)).send({ refundAmount: 10, reason: 'Order cancelled' });
    expect(res.status).toBe(201);
    expect((await money(id)).debt).toBe('Cancelled 0.00');
  });
});
