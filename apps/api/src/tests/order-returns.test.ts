/**
 * order-returns.test.ts
 *
 * #166 (owner decisions 1a, 2a, 3a, 4a, 2026-10-24): a delivered customer
 * order is returned through Returns, by the same rules as a counter sale.
 * One Returns module names either sale (1a); only a delivered order is
 * returned, an undelivered one is cancelled (2a); the return window counts
 * from delivery (3a); the order stays completed and its lines show what came
 * back (4a). The money goes back through the order's own payments, so the
 * Payments page and the reports see each refund once. Each test names what
 * happened before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'ordret_test_';
const BRANCH_PREFIX = 'Order Returns ';
const CUSTOMER_CODE = 'ORDRET-001';

describe('Returning a delivered customer order', () => {
  let branchId: number;
  let otherBranch: number;
  let locationId: number;
  let bookId: number;
  let price: number;
  let customerId: number;
  let sales: string;
  let manager: string;
  let otherManager: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = manager, branch = branchId) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branch));
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const onHand = async () => (await one(`SELECT quantity, damaged_quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]));

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    const customer = `SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`;
    for (const statement of [
      `DELETE FROM order_refunds WHERE order_id IN (${orders})`,
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM order_payments WHERE order_id IN (${orders})`,
      `DELETE FROM financial_transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${orders})`,
      `DELETE FROM order_line_items WHERE order_id IN (${orders})`,
      `DELETE FROM orders WHERE id IN (${orders})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM branch_config WHERE branch_id IN (${branches})`,
      `DELETE FROM store_credit_history WHERE customer_id IN (${customer})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customer})`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (${customer})`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    await db.query(`DELETE FROM customers WHERE customer_code = $1`, [CUSTOMER_CODE]);
  }

  /** An order of `quantity` copies, confirmed (paid in cash unless on credit) and, unless asked not to, delivered. */
  async function order(quantity: number, opts: { credit?: boolean; deliver?: boolean } = {}) {
    const created = await as(api().post('/api/v1/orders'), sales).send({
      locationId, customerId, saleType: opts.credit ? 'credit_sale' : 'cash_sale', items: [{ bookId, quantity }],
    });
    expect(created.status).toBe(201);
    const id = String(created.body.id);
    const confirmed = await as(api().post(`/api/v1/orders/${id}/confirm`), sales).send(opts.credit ? { dueDate: '2099-12-31' } : { paymentMethod: 'cash' });
    expect(confirmed.status).toBe(200);
    if (opts.deliver !== false) expect((await as(api().post(`/api/v1/orders/${id}/fulfill`), manager)).status).toBe(200);
    const read = await as(api().get(`/api/v1/orders/${id}`));
    return { id, orderNumber: read.body.orderNumber as string, lineId: Number(read.body.lineItems[0].id) };
  }
  const giveBack = (o: { id: string; lineId: number }, quantity: number, token = manager, extra: object = {}) =>
    as(api().post('/api/v1/returns'), token).send({ orderId: Number(o.id), lines: [{ orderLineItemId: o.lineId, quantity }], reason: 'Not wanted', ...extra });

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    otherBranch = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    otherManager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr_b`, role: 'Manager', branchId: otherBranch })).token;
    locationId = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Order Returns Loc', true) RETURNING id`, [branchId])).id;
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, 100, 5, 0, 4)`, [bookId, locationId]);
    customerId = (await one(`INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Order Returns Customer', $1, true) RETURNING id`, [CUSTOMER_CODE])).id;
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 0)`, [customerId]);
  });

  afterAll(cleanUp);

  describe('a return names a delivered order (1a, 2a)', () => {
    it('takes back part of a paid order: the books to stock at their cost, the money back the way it was paid (was: refused, Returns took POS sales only)', async () => {
      const o = await order(2);
      const before = await onHand();
      const res = await giveBack(o, 1);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        orderId: o.id, orderNumber: o.orderNumber, transactionId: null, transactionNumber: null,
        totalRefundAmount: price, refundMethod: 'cash',
      });
      expect((await onHand()).quantity).toBe(before.quantity + 1);
      const history = await one(
        `SELECT reason_code, unit_cost FROM inventory_history WHERE book_id = $1 AND location_id = $2 ORDER BY id DESC LIMIT 1`, [bookId, locationId],
      );
      expect(history.reason_code).toBe('return');
      expect(Number(history.unit_cost)).toBe(4);

      const read = await as(api().get(`/api/v1/returns/${res.body.id}`));
      expect(read.body.lineItems).toEqual([expect.objectContaining({ orderLineItemId: String(o.lineId), transactionLineItemId: null, quantity: 1 })]);
      expect(read.body.refunds).toEqual([expect.objectContaining({ method: 'cash', amount: price })]);
    });

    it('records the refund on the order\'s payment, so the Payments page cannot refund it again (was: no return at all)', async () => {
      const o = await order(1);
      expect((await giveBack(o, 1)).status).toBe(201);
      const payment = await one(`SELECT id, status FROM order_payments WHERE order_id = $1`, [o.id]);
      expect(payment.status).toBe('refunded');
      expect(await one(`SELECT refund_amount, method, return_id IS NOT NULL AS from_return FROM order_refunds WHERE order_id = $1`, [o.id]))
        .toEqual({ refund_amount: price.toFixed(2), method: 'cash', from_return: true });
      const again = await as(api().post(`/api/v1/payments/${payment.id}/refund`)).send({ refundAmount: 1, reason: 'Again' });
      expect(again.status).toBe(422);
    });

    it('never takes back more than was delivered (was: no return at all)', async () => {
      const o = await order(2);
      expect((await giveBack(o, 2)).status).toBe(201);
      const again = await giveBack(o, 1);
      expect(again.status).toBe(422);
      expect(again.body.error).toBe('OVER_RETURN');
    });

    it('leaves the order completed, its line showing what came back (4a)', async () => {
      const o = await order(3);
      expect((await giveBack(o, 2)).status).toBe(201);
      const read = await as(api().get(`/api/v1/orders/${o.id}`));
      expect(read.body.status).toBe('COMPLETED');
      expect(read.body.lineItems[0]).toMatchObject({ quantity: 3, qtyReturned: 2 });
      // What is kept is paid: the returned part is no longer counted.
      expect(read.body.paymentStatus).toBe('paid');
    });

    it('refuses an order not delivered yet: it is cancelled instead (2a)', async () => {
      const o = await order(1, { deliver: false });
      const res = await giveBack(o, 1);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('ORDER_NOT_DELIVERED');
    });

    it('still sends a delivered order\'s cancel to Returns', async () => {
      const o = await order(1);
      const res = await as(api().post(`/api/v1/orders/${o.id}/cancel`)).send({ reason: 'Late', refundTo: 'original' });
      expect(res.body.error).toBe('ORDER_ALREADY_FULFILLED');
    });

    it('takes an order of its own branch only', async () => {
      const o = await order(1);
      const fromOther = await as(api().post('/api/v1/returns'), otherManager, otherBranch).send({ orderId: Number(o.id), lines: [{ orderLineItemId: o.lineId, quantity: 1 }] });
      expect(fromOther.status).toBe(404);
    });

    it('refuses a line of another sale', async () => {
      const a = await order(1);
      const b = await order(1);
      const res = await as(api().post('/api/v1/returns')).send({ orderId: Number(a.id), lines: [{ orderLineItemId: b.lineId, quantity: 1 }] });
      expect(res.status).toBe(404);
    });
  });

  describe('by the same rules as a counter sale', () => {
    it('sets the value first against what a credit order still owes, as a credit note', async () => {
      const o = await order(2, { credit: true });
      const res = await giveBack(o, 1);
      expect(res.status).toBe(201);
      expect(res.body.refundMethod).toBe('credit_note');
      const debt = await one(`SELECT outstanding_amount FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1`, [o.id]);
      expect(Number(debt.outstanding_amount)).toBeCloseTo(price, 2);
      expect(await one(`SELECT COUNT(*)::int AS n FROM order_refunds WHERE order_id = $1`, [o.id])).toEqual({ n: 0 });
    });

    it('then takes payment for what is kept only, and settles the debt (was: the full total stayed owed)', async () => {
      const o = await order(2, { credit: true });
      expect((await giveBack(o, 1)).status).toBe(201);
      const unpaid = () => as(api().get(`/api/v1/payments/unpaid-orders?entityId=${o.id}&sourceType=order`));
      expect((await unpaid()).body.items).toHaveLength(1);
      const pay = (amount: number) => as(api().post('/api/v1/payments'), manager).send({ orderId: Number(o.id), amount, paymentMethod: 'cash' });
      const over = await pay(price + 1);
      expect(over.status).toBe(422);
      expect(over.body.error).toBe('EXCEEDS_ORDER_TOTAL');
      expect((await pay(price)).status).toBe(201);
      const debt = await one(`SELECT status, outstanding_amount FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1`, [o.id]);
      expect(debt).toEqual({ status: 'Settled', outstanding_amount: '0.00' });
      expect((await as(api().get(`/api/v1/orders/${o.id}`))).body.paymentStatus).toBe('paid');
      expect((await unpaid()).body.items).toEqual([]);
    });

    it('keeps damaged books apart, not for sale', async () => {
      const o = await order(1);
      const before = await onHand();
      const res = await as(api().post('/api/v1/returns')).send({ orderId: Number(o.id), lines: [{ orderLineItemId: o.lineId, quantity: 1, disposition: 'DAMAGED' }] });
      expect(res.status).toBe(201);
      const after = await onHand();
      expect(after.quantity).toBe(before.quantity);
      expect(after.damaged_quantity).toBe(before.damaged_quantity + 1);
    });

    it('above the approval limit, is for a Manager or Admin', async () => {
      await db.query(`UPDATE system_config SET value = '1' WHERE key = 'max_return_value_without_auth'`);
      try {
        const o = await order(1);
        const res = await giveBack(o, 1, sales);
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('APPROVAL_REQUIRED');
        expect((await giveBack(o, 1, manager)).status).toBe(201);
      } finally {
        await db.query(`UPDATE system_config SET value = '500' WHERE key = 'max_return_value_without_auth'`);
      }
    });

    it('counts the return window from delivery, not from the order (3a)', async () => {
      await db.query(`INSERT INTO branch_config (branch_id, key, value, updated_by) VALUES ($1, 'return_window_days', '5', 1)`, [branchId]);
      await db.query(`UPDATE system_config SET value = '"store_credit_only"' WHERE key = 'refund_method_after_window'`);
      try {
        const recent = await order(1);
        // Ordered long ago, delivered today: within the window.
        await db.query(`UPDATE orders SET created_at = now() - interval '30 days' WHERE id = $1`, [recent.id]);
        expect((await giveBack(recent, 1)).body.refundMethod).toBe('cash');

        const late = await order(1);
        await db.query(`UPDATE orders SET fulfilled_at = now() - interval '10 days' WHERE id = $1`, [late.id]);
        const credit = async () => Number((await one(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId])).balance);
        const before = await credit();
        const res = await giveBack(late, 1);
        expect(res.status).toBe(201);
        expect(res.body.refundMethod).toBe('store_credit');
        expect(await credit()).toBeCloseTo(before + price, 2);
      } finally {
        await db.query(`UPDATE system_config SET value = '"any"' WHERE key = 'refund_method_after_window'`);
        await db.query(`DELETE FROM branch_config WHERE branch_id = $1 AND key = 'return_window_days'`, [branchId]);
      }
    });

    it('records when an order was delivered', async () => {
      const o = await order(1);
      const read = await as(api().get(`/api/v1/orders/${o.id}`));
      expect(read.body.fulfilledAt).toEqual(expect.any(String));
      expect((await order(1, { deliver: false })).id).toBeTruthy();
    });
  });

  describe('in the money reports', () => {
    it('counts the refund once, as money out, and the returned books as a return in sales', async () => {
      const day = (await one(`SELECT CURRENT_DATE::text AS d`)).d as string;
      const report = async () => (await as(api().get(`/api/v1/reports/payments?dateFrom=${day}&dateTo=${day}`))).body.summary;
      const sales = async () => (await as(api().get(`/api/v1/reports/sales?dateFrom=${day}&dateTo=${day}`))).body.summary;
      const [before, salesBefore] = [await report(), await sales()];
      const o = await order(1);
      expect((await giveBack(o, 1)).status).toBe(201);
      const [after, salesAfter] = [await report(), await sales()];
      expect(after.totalRefunded).toBeCloseTo(before.totalRefunded + price, 2);
      expect(after.totalCollected).toBeCloseTo(before.totalCollected + price, 2);
      expect(salesAfter.returnsValue).toBeCloseTo(salesBefore.returnsValue + price, 2);
    });

    it('counts a credit note as no money out, and takes it off profit once (was: refunded, and taken off profit twice)', async () => {
      const day = (await one(`SELECT CURRENT_DATE::text AS d`)).d as string;
      const reports = async () => {
        const money = (await as(api().get(`/api/v1/reports/payments?dateFrom=${day}&dateTo=${day}`))).body.summary;
        const sales = (await as(api().get(`/api/v1/reports/sales?dateFrom=${day}&dateTo=${day}`))).body.summary;
        return { refunded: money.totalRefunded as number, profit: sales.netProfit as number };
      };
      const before = await reports();
      const o = await order(2, { credit: true });
      const res = await giveBack(o, 1);
      expect(res.body.refundMethod).toBe('credit_note');
      const after = await reports();
      expect(after.refunded).toBeCloseTo(before.refunded, 2);
      // Nothing collected yet: the two copies cost 4 each, the returned one's cost comes back.
      expect(after.profit).toBeCloseTo(before.profit - 8 + 4, 2);
    });

    it('lists the return under the order in Returns', async () => {
      const o = await order(1);
      expect((await giveBack(o, 1)).status).toBe(201);
      const res = await as(api().get(`/api/v1/returns?orderId=${o.id}`));
      expect(res.body.items).toEqual([expect.objectContaining({ orderNumber: o.orderNumber })]);
    });
  });
});
