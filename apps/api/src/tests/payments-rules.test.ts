import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Order payments after the move to the layered structure (#21, payments
// part 1). Each test names what the endpoint did before.

const STAFF_PREFIX = 'payrule_test_';
const BRANCH_PREFIX = 'Pay Rule ';
const CUSTOMER_CODE = 'PAYRULE-001';
const ACCOUNT_PREFIX = 'PAYRULE-ACC-';

describe('Order payments', () => {
  let branchId: number;
  let otherBranchId: number;
  let locationId: number;
  let customerId: number;
  let bookId: number;
  let sales: string;
  let manager: string;
  let clerk: string;
  let otherSales: string;
  let bankAccount: number;
  let inactiveAccount: number;
  let otherBranchAccount: number;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = manager, branch = branchId) =>
    r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branch));

  async function creditOrder(opts: { confirm?: boolean; quantity?: number } = {}): Promise<{ id: number; total: number }> {
    const res = await as(api().post('/api/v1/orders'), sales).send({
      locationId, saleType: 'credit_sale', customerId, items: [{ bookId, quantity: opts.quantity ?? 2 }],
    });
    expect(res.status).toBe(201);
    if (opts.confirm) expect((await as(api().post(`/api/v1/orders/${res.body.id}/confirm`)).send({ dueDate: '2099-12-31' })).status).toBe(200);
    return { id: Number(res.body.id), total: Number(res.body.total) };
  }

  const pay = (orderId: number, amount: number, extra: Record<string, unknown> = {}, token = sales) =>
    as(api().post('/api/v1/payments'), token).send({ orderId, amount, paymentMethod: 'cash', ...extra });
  const refund = (paymentId: string, refundAmount: number, extra: Record<string, unknown> = {}) =>
    as(api().post(`/api/v1/payments/${paymentId}/refund`)).send({ refundAmount, reason: 'Paid twice by mistake', ...extra });
  const unpaidRows = async (): Promise<string[]> =>
    (await as(api().get(`/api/v1/payments/unpaid-orders?pageSize=100`), sales)).body.items.map(
      (o: { id: string; sourceType: string }) => `${o.sourceType}:${o.id}`,
    );
  const balances = async () => {
    const { rows } = await db.query(
      `SELECT sca.balance, la.points_balance, la.lifetime_points FROM customers c
       LEFT JOIN store_credit_accounts sca ON sca.customer_id = c.id LEFT JOIN loyalty_accounts la ON la.customer_id = c.id
       WHERE c.id = $1`,
      [customerId],
    );
    return { storeCredit: Number(rows[0].balance), points: Number(rows[0].points_balance), lifetime: Number(rows[0].lifetime_points) };
  };

  async function cleanUp() {
    const orders = `SELECT o.id FROM orders o JOIN branches b ON b.id = o.branch_id WHERE b.name LIKE '${BRANCH_PREFIX}%'`;
    const accounts = `SELECT id FROM bank_accounts WHERE account_number LIKE '${ACCOUNT_PREFIX}%'`;
    const customer = `SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`;
    for (const statement of [
      `DELETE FROM bank_reconciliation WHERE bank_account_id IN (${accounts})`,
      `DELETE FROM order_refunds WHERE order_id IN (${orders})`,
      `DELETE FROM order_payments WHERE order_id IN (${orders})`,
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
      `DELETE FROM bank_accounts WHERE account_number LIKE '${ACCOUNT_PREFIX}%'`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    otherBranchId = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    clerk = (await createTestStaff({ username: `${STAFF_PREFIX}clerk`, role: 'Stock_Clerk', branchId })).token;
    otherSales = (await createTestStaff({ username: `${STAFF_PREFIX}othersales`, role: 'Sales', branchId: otherBranchId })).token;

    locationId = (await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Pay Rule Loc', true) RETURNING id`,
      [branchId],
    )).rows[0].id;
    bookId = (await db.query(`SELECT id FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`)).rows[0].id;
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 500, 5, 0)`, [bookId, locationId]);
    customerId = (await db.query(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Pay Rule Customer', $1, true) RETURNING id`,
      [CUSTOMER_CODE],
    )).rows[0].id;
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 1000)`, [customerId]);
    await db.query(`INSERT INTO loyalty_accounts (customer_id, points_balance, lifetime_points) VALUES ($1, 1000, 1000)`, [customerId]);

    const account = async (branch: number, n: number, active = true) =>
      (await db.query(
        `INSERT INTO bank_accounts (branch_id, account_name, bank_name, account_number, currency, is_active)
         VALUES ($1, 'Pay Rule', 'CBE', $2, 'ETB', $3) RETURNING id`,
        [branch, `${ACCOUNT_PREFIX}${n}`, active],
      )).rows[0].id;
    bankAccount = await account(branchId, 1);
    inactiveAccount = await account(branchId, 2, false);
    otherBranchAccount = await account(otherBranchId, 3);
  });

  afterAll(cleanUp);

  describe('taking a payment', () => {
    it('refuses another branch\'s order (was: 201, booked to the wrong branch)', async () => {
      const order = await creditOrder();
      const res = await pay(order.id, 1, {}, otherSales);
      expect(res.status).toBe(404);
      const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM order_payments WHERE order_id = $1`, [order.id]);
      expect(rows[0].n).toBe(0);
    });

    it('lets only one of two simultaneous full payments through (was: the second failed with a 500, or both went through)', async () => {
      const order = await creditOrder();
      const results = await Promise.all([pay(order.id, order.total), pay(order.id, order.total)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      const { rows } = await db.query(`SELECT COALESCE(SUM(amount), 0) AS paid FROM order_payments WHERE order_id = $1`, [order.id]);
      expect(Number(rows[0].paid)).toBeCloseTo(order.total, 2);
    });

    it('numbers payments taken at the same moment differently (was: one failed on a duplicate number)', async () => {
      // Orders one at a time: order numbers still collide (#68).
      const orders = [];
      for (let i = 0; i < 5; i++) orders.push(await creditOrder());
      const results = await Promise.all(orders.map((o) => pay(o.id, 1)));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(results.map((r) => r.body.paymentReference)).size).toBe(5);
    });

    it('refuses an unknown payment method with 400 (was: 500)', async () => {
      const order = await creditOrder();
      const res = await pay(order.id, 1, { paymentMethod: 'cheque' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('refunds', () => {
    it('let only one of two simultaneous full refunds through (was: both, refunded twice)', async () => {
      const order = await creditOrder();
      const payment = (await pay(order.id, order.total)).body;
      const results = await Promise.all([refund(payment.id, order.total), refund(payment.id, order.total)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    });

    it('make a credit sale owed again: its receivable reopens and it is back in Unpaid Orders (was: settled, not listed)', async () => {
      const order = await creditOrder({ confirm: true });
      const payment = (await pay(order.id, order.total)).body;
      expect(await unpaidRows()).not.toContain(`order:${order.id}`);

      expect((await refund(payment.id, 10)).status).toBe(201);
      const receivable = (await db.query(
        `SELECT status, outstanding_amount FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1`,
        [order.id],
      )).rows[0];
      expect([receivable.status, Number(receivable.outstanding_amount)]).toEqual(['PartiallyPaid', 10]);
      expect(await unpaidRows()).toContain(`order:${order.id}`);
      const balance = (await as(api().get(`/api/v1/orders/${order.id}/balance`), sales)).body;
      expect([balance.outstanding, balance.paymentStatus]).toEqual([10, 'partial']);
    });

    it('count when the order is confirmed: a refund before then is owed (was: left out of the receivable)', async () => {
      const order = await creditOrder();
      const payment = (await pay(order.id, 10)).body;
      expect((await refund(payment.id, 10)).status).toBe(201);
      await as(api().post(`/api/v1/orders/${order.id}/confirm`)).send({ dueDate: '2099-12-31' });
      const { rows } = await db.query(
        `SELECT original_amount FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1`,
        [order.id],
      );
      expect(Number(rows[0].original_amount)).toBeCloseTo(order.total, 2);
    });

    it('give store credit back (was: kept)', async () => {
      const order = await creditOrder();
      const before = await balances();
      const payment = (await pay(order.id, 8, { paymentMethod: 'store_credit' })).body;
      expect((await balances()).storeCredit).toBeCloseTo(before.storeCredit - 8, 2);
      expect((await refund(payment.id, 8)).status).toBe(201);
      expect((await balances()).storeCredit).toBeCloseTo(before.storeCredit, 2);
    });

    it('give loyalty points back, without counting them as earned again (was: kept)', async () => {
      const order = await creditOrder();
      const before = await balances();
      const payment = (await pay(order.id, 8, { paymentMethod: 'loyalty_points' })).body;
      expect((await refund(payment.id, 8)).status).toBe(201);
      const after = await balances();
      expect([after.points, after.lifetime]).toEqual([before.points, before.lifetime]);
    });

    it('send a bank payment back to its account by default (was: no bank movement)', async () => {
      const order = await creditOrder();
      const payment = (await pay(order.id, 8, { paymentMethod: 'bank', bankAccountId: bankAccount })).body;
      const res = await refund(payment.id, 8);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ method: 'bank', bankAccountId: bankAccount });
      const { rows } = await db.query(
        `SELECT bank_account_id, direction FROM bank_reconciliation WHERE refund_ref_id = $1`,
        [res.body.id],
      );
      expect(rows).toEqual([{ bank_account_id: bankAccount, direction: 'out' }]);
    });

    it('refuse an inactive or another branch\'s bank account (was: 201)', async () => {
      const order = await creditOrder();
      const payment = (await pay(order.id, 8, { paymentMethod: 'bank', bankAccountId: bankAccount })).body;
      for (const account of [inactiveAccount, otherBranchAccount]) {
        const res = await refund(payment.id, 2, { bankAccountId: account });
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('INVALID_BANK_ACCOUNT');
      }
    });

    it('do not send a cash payment to a bank account (was: 201)', async () => {
      const order = await creditOrder();
      const payment = (await pay(order.id, 8)).body;
      const res = await refund(payment.id, 2, { bankAccountId: bankAccount });
      expect(res.status).toBe(400);
    });
  });

  describe('reading payments', () => {
    it('is for the roles that take payments (was: any signed-in staff member)', async () => {
      const order = await creditOrder();
      const payment = (await pay(order.id, 5)).body;
      for (const path of ['/api/v1/payments', `/api/v1/payments/${payment.id}`, `/api/v1/orders/${order.id}/payments`, `/api/v1/orders/${order.id}/balance`]) {
        expect((await as(api().get(path), clerk)).status).toBe(403);
        expect((await as(api().get(path), sales)).status).toBe(200);
      }
    });

    it('includes the last day of a date range (was: left out)', async () => {
      const order = await creditOrder();
      const payment = (await pay(order.id, 5)).body;
      const today = (await db.query(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0].d;
      const res = await as(api().get(`/api/v1/payments?dateFrom=${today}&dateTo=${today}&pageSize=100`), sales);
      expect(res.body.items.map((p: { id: string }) => p.id)).toContain(payment.id);
    });

    it('leaves a cancelled credit order out of Unpaid Orders', async () => {
      const order = await creditOrder({ confirm: true });
      expect(await unpaidRows()).toContain(`order:${order.id}`);
      expect((await as(api().post(`/api/v1/orders/${order.id}/cancel`)).send({ reason: 'Customer changed mind' })).status).toBe(200);
      expect(await unpaidRows()).not.toContain(`order:${order.id}`);
    });
  });
});
