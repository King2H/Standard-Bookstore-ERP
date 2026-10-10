import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Returns after the move to the layered structure (#21, returns). Each test
// names what the endpoint did before.

const STAFF_PREFIX = 'retrule_test_';
const BRANCH_PREFIX = 'Ret Rule ';
const CUSTOMER_CODE = 'RETRULE-001';
const ORDER_NUMBER = 'RETRULE-ORD-1';

interface Sale {
  id: string;
  transactionNumber: string;
  grandTotal: number;
  lineItems: Array<{ id: string; quantity: number; lineTotal: number }>;
}

describe('Returns', () => {
  let branchId: number;
  let otherBranchId: number;
  let locationId: number;
  let customerId: number;
  let bookId: number;
  let price: number;
  let sales: string;
  let manager: string;
  let managerId: number;
  let admin: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = sales) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));

  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const stock = async () => one(`SELECT quantity, damaged_quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
  const storeCredit = async () => Number((await one(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId])).balance);
  const points = async () => Number((await one(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1`, [customerId])).points_balance);

  async function sell(body: Record<string, unknown> = {}, token = manager): Promise<Sale> {
    const res = await as(api().post('/api/v1/pos/transactions'), token).send({
      locationId, items: [{ bookId, quantity: 1 }], payments: [{ method: 'cash', amount: price }], ...body,
    });
    expect(res.status).toBe(201);
    return res.body as Sale;
  }

  function giveBack(sale: Sale, quantity: number, token = manager, extra: Record<string, unknown> = {}) {
    return as(api().post('/api/v1/returns'), token).send({
      transactionId: Number(sale.id),
      lines: [{ transactionLineItemId: Number(sale.lineItems[0].id), quantity }],
      ...extra,
    });
  }

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const customer = `SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`;
    for (const statement of [
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM orders WHERE order_number = '${ORDER_NUMBER}'`,
      `DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM branch_config WHERE branch_id IN (${branches})`,
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
    otherBranchId = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    const mgr = await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId });
    manager = mgr.token;
    managerId = mgr.staffId;
    admin = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId })).token;
    locationId = (await one(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Ret Rule Loc', true) RETURNING id`,
      [branchId],
    )).id;
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 500, 5, 0)`, [bookId, locationId]);
    customerId = (await one(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Ret Rule Customer', $1, true) RETURNING id`,
      [CUSTOMER_CODE],
    )).id;
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 1000)`, [customerId]);
    await db.query(`INSERT INTO loyalty_accounts (customer_id, points_balance, lifetime_points) VALUES ($1, 1000, 1000)`, [customerId]);
  });

  afterAll(cleanUp);

  describe('what a return is worth', () => {
    it('refunds what the line cost after a discount given as an amount (was: the undiscounted price)', async () => {
      const sale = await sell({
        items: [{ bookId, quantity: 2, discountMode: 'Amount', discountAmount: 1 }],
        payments: [{ method: 'cash', amount: Number((price * 2 - 1).toFixed(2)) }],
      });
      const res = await giveBack(sale, 2);
      expect(res.status).toBe(201);
      expect(res.body.totalRefundAmount).toBe(sale.lineItems[0].lineTotal);
    });

    it('gives back exactly what the line cost over several partial returns', async () => {
      const sale = await sell({
        items: [{ bookId, quantity: 3, discountMode: 'Amount', discountAmount: 1 }],
        payments: [{ method: 'cash', amount: Number((price * 3 - 1).toFixed(2)) }],
      });
      const amounts: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await giveBack(sale, 1);
        expect(res.status).toBe(201);
        amounts.push(Math.round(res.body.totalRefundAmount * 100));
      }
      expect(amounts.reduce((a, b) => a + b, 0)).toBe(Math.round(sale.lineItems[0].lineTotal * 100));
    });

    it('lets only one of two simultaneous returns of the last unit through (was: both, refunded twice)', async () => {
      const sale = await sell();
      const results = await Promise.all([giveBack(sale, 1), giveBack(sale, 1)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      const { returned } = await one(
        `SELECT SUM(rli.quantity)::int AS returned FROM return_line_items rli JOIN returns r ON r.id = rli.return_id WHERE r.transaction_id = $1`,
        [sale.id],
      );
      expect(returned).toBe(1);
    });
  });

  describe('a credit sale', () => {
    async function creditSale(quantity: number): Promise<{ sale: Sale; receivableId: string }> {
      const sale = await sell({ customerId, items: [{ bookId, quantity }], payments: [], allowCredit: true });
      const rec = await one(`SELECT id FROM receivables WHERE source_type = 'pos_credit_sale' AND source_entity_id = $1`, [sale.id]);
      return { sale, receivableId: String(rec.id) };
    }

    it('sets a return against what is still owed, as a credit note (was: 422 REFUND_EXCEEDS_PAID)', async () => {
      const { sale, receivableId } = await creditSale(2);
      const res = await giveBack(sale, 1);
      expect(res.status).toBe(201);
      expect(res.body.refundMethod).toBe('credit_note');
      expect(res.body.refunds.map((r: { method: string; amount: number }) => [r.method, r.amount])).toEqual([['credit_note', price]]);

      const rec = await one(`SELECT outstanding_amount, credited_amount, status FROM receivables WHERE id = $1`, [receivableId]);
      expect(Number(rec.outstanding_amount)).toBe(price);
      expect(Number(rec.credited_amount)).toBe(price);
      expect(rec.status).toBe('Pending');
      const t = await one(`SELECT amount_due, payment_status FROM transactions WHERE id = $1`, [sale.id]);
      expect(Number(t.amount_due)).toBe(price);
    });

    it('takes a later payment from what is owed after the credit note (was: the sale stayed part-paid)', async () => {
      const { sale, receivableId } = await creditSale(2);
      expect((await giveBack(sale, 1)).status).toBe(201);
      const res = await as(api().post(`/api/v1/pos/transactions/${sale.id}/payment`)).send({ payments: [{ method: 'cash', amount: price }] });
      expect(res.status).toBe(200);
      expect(res.body.paymentStatus).toBe('paid');
      expect(res.body.amountDue).toBe(0);
      const rec = await one(`SELECT outstanding_amount, status FROM receivables WHERE id = $1`, [receivableId]);
      expect(Number(rec.outstanding_amount)).toBe(0);
      expect(rec.status).toBe('Settled');
    });

    it('credits what is owed first and refunds only the paid part', async () => {
      const sale = await sell({ customerId, items: [{ bookId, quantity: 2 }], payments: [{ method: 'cash', amount: price }], allowCredit: true });
      const res = await giveBack(sale, 2);
      expect(res.status).toBe(201);
      expect(res.body.refundMethod).toBe('mixed');
      const byMethod = Object.fromEntries(res.body.refunds.map((r: { method: string; amount: number }) => [r.method, r.amount]));
      expect(byMethod).toEqual({ credit_note: price, cash: price });
      const rec = await one(`SELECT outstanding_amount, status FROM receivables WHERE source_type = 'pos_credit_sale' AND source_entity_id = $1`, [sale.id]);
      expect(rec.status).toBe('Settled');
    });

    it("leaves another order's receivable alone (was: reduced by the refund)", async () => {
      const order = await one(
        `INSERT INTO orders (branch_id, created_by, order_number, customer_id, status, sale_type, total)
         VALUES ($1, $2, $3, $4, 'Fulfilled', 'credit_sale', 100) RETURNING id`,
        [branchId, managerId, ORDER_NUMBER, customerId],
      );
      const rec = await one(
        `INSERT INTO receivables (source_type, source_ref_id, source_entity_id, customer_id, branch_id, original_amount, outstanding_amount, status)
         VALUES ('order_credit_sale', $1, $2, $3, $4, 100, 100, 'Pending') RETURNING id`,
        [ORDER_NUMBER, order.id, customerId, branchId],
      );
      const sale = await sell({ customerId });
      expect((await giveBack(sale, 1)).status).toBe(201);
      const after = await one(`SELECT outstanding_amount, status FROM receivables WHERE id = $1`, [rec.id]);
      expect(Number(after.outstanding_amount)).toBe(100);
      expect(after.status).toBe('Pending');
    });
  });

  describe('how the money goes back', () => {
    it('refunds the way the sale was paid; the request names no method (was: the cashier chose)', async () => {
      const sale = await sell({ payments: [{ method: 'mobile', amount: price }] });
      const res = await giveBack(sale, 1, manager, { refundMethod: 'store_credit' });
      expect(res.status).toBe(201);
      expect(res.body.refundMethod).toBe('mobile');
    });

    it('puts store credit and points back on the account (was: cash or store credit only)', async () => {
      const half = Number((price / 2).toFixed(2));
      const sale = await sell({
        customerId,
        payments: [{ method: 'store_credit', amount: half }, { method: 'loyalty_points', amount: Number((price - half).toFixed(2)) }],
      });
      const [credit, pts] = [await storeCredit(), await points()];
      const res = await giveBack(sale, 1);
      expect(res.status).toBe(201);
      expect(res.body.refundMethod).toBe('mixed');
      expect(await storeCredit()).toBeCloseTo(credit + half, 2);
      expect(await points()).toBeCloseTo(pts + (price - half), 2);
    });

    it('counts the return window in calendar days of the database (was: hours since the sale)', async () => {
      await db.query(`INSERT INTO branch_config (branch_id, key, value, updated_by) VALUES ($1, 'return_window_days', '1', 1)`, [branchId]);
      await db.query(`UPDATE system_config SET value = '"store_credit_only"' WHERE key = 'refund_method_after_window'`);
      try {
        const sale = await sell();
        await db.query(`UPDATE transactions SET created_at = (CURRENT_DATE - 1)::timestamp + interval '1 minute' WHERE id = $1`, [sale.id]);
        const res = await giveBack(sale, 1, manager, { refundMethod: 'cash' });
        expect(res.status).toBe(201);
        expect(res.body.refundMethod).toBe('cash');
      } finally {
        await db.query(`UPDATE system_config SET value = '"any"' WHERE key = 'refund_method_after_window'`);
        await db.query(`DELETE FROM branch_config WHERE branch_id = $1 AND key = 'return_window_days'`, [branchId]);
      }
    });

    it('after the window, refunds store credit only, which needs a customer', async () => {
      await db.query(`INSERT INTO branch_config (branch_id, key, value, updated_by) VALUES ($1, 'return_window_days', '1', 1)`, [branchId]);
      await db.query(`UPDATE system_config SET value = '"store_credit_only"' WHERE key = 'refund_method_after_window'`);
      try {
        const withCustomer = await sell({ customerId });
        const anonymous = await sell();
        await db.query(`UPDATE transactions SET created_at = now() - interval '3 days' WHERE id IN ($1, $2)`, [withCustomer.id, anonymous.id]);
        const credit = await storeCredit();
        const res = await giveBack(withCustomer, 1);
        expect(res.status).toBe(201);
        expect(res.body.refundMethod).toBe('store_credit');
        expect(await storeCredit()).toBeCloseTo(credit + price, 2);

        const refused = await giveBack(anonymous, 1);
        expect(refused.status).toBe(422);
        expect(refused.body.error).toBe('STORE_CREDIT_REQUIRES_CUSTOMER');
      } finally {
        await db.query(`UPDATE system_config SET value = '"any"' WHERE key = 'refund_method_after_window'`);
        await db.query(`DELETE FROM branch_config WHERE branch_id = $1 AND key = 'return_window_days'`, [branchId]);
      }
    });

    it('takes back the points the returned part earned, in proportion', async () => {
      const sale = await sell({ customerId, items: [{ bookId, quantity: 2 }], payments: [{ method: 'cash', amount: price * 2 }] });
      await db.query(
        `INSERT INTO loyalty_history (customer_id, transaction_ref, points_delta, reason) VALUES ($1, $2, 10, 'ACCRUAL')`,
        [customerId, sale.transactionNumber],
      );
      const before = await points();
      expect((await giveBack(sale, 1)).status).toBe(201);
      expect(await points()).toBe(before - 5);
      expect((await giveBack(sale, 1)).status).toBe(201);
      expect(await points()).toBe(before - 10);
    });
  });

  describe('who may return what', () => {
    it('above the limit, ignores an approver named by the client (was: 201, approved by anyone named)', async () => {
      const quantity = Math.ceil(510 / price);
      const sale = await sell({ items: [{ bookId, quantity }], payments: [{ method: 'cash', amount: Number((price * quantity).toFixed(2)) }] });
      const refused = await giveBack(sale, quantity, sales, { approvedBy: managerId });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('APPROVAL_REQUIRED');

      const res = await giveBack(sale, quantity, manager);
      expect(res.status).toBe(201);
      expect(res.body.approvedBy).toBe(managerId);
    });

    it("does not return another branch's sale, whatever the role (was: Admin 201)", async () => {
      const sale = await sell();
      await db.query(`UPDATE transactions SET branch_id = $1 WHERE id = $2`, [otherBranchId, sale.id]);
      const res = await giveBack(sale, 1, admin);
      expect(res.status).toBe(404);
      expect((await giveBack(sale, 1, sales)).status).toBe(404);
    });

    it('answers 410 to reject: a return is complete when it is made', async () => {
      const sale = await sell();
      const ret = await giveBack(sale, 1);
      const res = await as(api().post(`/api/v1/returns/${ret.body.id}/reject`), manager);
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('DEPRECATED');
    });
  });

  describe('stock and records', () => {
    it('keeps damaged books apart from the stock for sale', async () => {
      const sale = await sell();
      const before = await stock();
      const res = await as(api().post('/api/v1/returns')).send({
        transactionId: Number(sale.id),
        lines: [{ transactionLineItemId: Number(sale.lineItems[0].id), quantity: 1, disposition: 'DAMAGED' }],
      });
      expect(res.status).toBe(201);
      const after = await stock();
      expect(after.quantity).toBe(before.quantity);
      expect(after.damaged_quantity).toBe(before.damaged_quantity + 1);
    });

    it('numbers returns made at the same moment differently', async () => {
      const sold = [await sell(), await sell(), await sell()];
      const results = await Promise.all(sold.map((s) => giveBack(s, 1)));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(new Set(results.map((r) => r.body.returnNumber)).size).toBe(3);
    });

    it('lists the returns of the last day asked for (was: dateTo left that day out)', async () => {
      const ret = await giveBack(await sell(), 1);
      const { today } = await one(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
      const res = await as(api().get(`/api/v1/returns?dateFrom=${today}&dateTo=${today}&pageSize=100`));
      expect(res.status).toBe(200);
      expect(res.body.items.map((r: { id: string }) => r.id)).toContain(ret.body.id);
    });

    it("names the sale's number in the return notification (was: its id)", async () => {
      const sale = await sell();
      const ret = await giveBack(sale, 1);
      const event = await one(`SELECT payload FROM outbox WHERE event_type = 'return.initiated' AND payload->>'returnId' = $1`, [ret.body.id]);
      expect(event.payload.txNumber).toBe(sale.transactionNumber);
    });
  });
});
