import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';
import { getReceivablesExportRows } from '../modules/reports/reports.service.js';

// Counter sales after the move to the layered structure (#21, POS). Each test
// names what the endpoint did before.

const STAFF_PREFIX = 'posrule_test_';
const BRANCH_PREFIX = 'Pos Rule ';
const CUSTOMER_CODE = 'POSRULE-001';

describe('Counter sales', () => {
  let branchId: number;
  let locationId: number;
  let customerId: number;
  let bookId: number;
  let price: number;
  let sales: string;
  let manager: string;
  let clerk: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = sales) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));

  const stock = async (): Promise<number> =>
    Number((await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId])).rows[0].quantity);

  function sell(body: Record<string, unknown> = {}) {
    return as(api().post('/api/v1/pos/transactions')).send({
      locationId, items: [{ bookId, quantity: 1 }], payments: [{ method: 'cash', amount: price }], ...body,
    });
  }

  async function creditSale(quantity = 1): Promise<{ id: string; total: number; receivableId: string }> {
    const res = await sell({ customerId, items: [{ bookId, quantity }], payments: [], allowCredit: true });
    expect(res.status).toBe(201);
    const rec = await db.query(`SELECT id FROM receivables WHERE source_type = 'pos_credit_sale' AND source_entity_id = $1`, [res.body.id]);
    return { id: res.body.id, total: res.body.grandTotal, receivableId: String(rec.rows[0].id) };
  }

  const voidSale = (id: string) => as(api().post(`/api/v1/pos/transactions/${id}/void`), manager);
  const collect = (id: string, amount: number) =>
    as(api().post(`/api/v1/pos/transactions/${id}/payment`)).send({ payments: [{ method: 'cash', amount }] });

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const customer = `SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`;
    for (const statement of [
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
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
    clerk = (await createTestStaff({ username: `${STAFF_PREFIX}clerk`, role: 'Stock_Clerk', branchId })).token;
    locationId = (await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Pos Rule Loc', true) RETURNING id`,
      [branchId],
    )).rows[0].id;
    const book = (await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`)).rows[0];
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 500, 5, 0)`, [bookId, locationId]);
    customerId = (await db.query(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Pos Rule Customer', $1, true) RETURNING id`,
      [CUSTOMER_CODE],
    )).rows[0].id;
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 1000)`, [customerId]);
  });

  afterAll(cleanUp);

  describe('selling', () => {
    it('refuses store credit with no customer on the sale (was: 201, books given away)', async () => {
      const before = await stock();
      const res = await sell({ payments: [{ method: 'store_credit', amount: price }] });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('STORE_CREDIT_REQUIRES_CUSTOMER');
      expect(await stock()).toBe(before);
    });

    it('caps a discount entered as an amount at the role\'s maximum (was: 201, any discount)', async () => {
      const res = await sell({
        items: [{ bookId, quantity: 1, discountMode: 'Amount', discountAmount: price }],
        payments: [],
        customerId,
        allowCredit: true,
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('DISCOUNT_EXCEEDS_LIMIT');
    });

    it('refuses a zero payment or an unknown method with 400 (was: 500)', async () => {
      expect((await sell({ payments: [{ method: 'cash', amount: 0 }, { method: 'cash', amount: price }] })).status).toBe(400);
      expect((await sell({ payments: [{ method: 'cheque', amount: price }] })).status).toBe(400);
    });

    it('refuses a credit sale with an impossible due date, instead of losing the debt (was: 201, no receivable)', async () => {
      const before = await stock();
      const res = await sell({ customerId, payments: [], allowCredit: true, dueDate: '2026-02-31' });
      expect(res.status).toBe(400);
      expect(await stock()).toBe(before);
    });

    it('numbers sales made at the same moment differently (was: one failed with 500)', async () => {
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => sell()));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(results.map((r) => r.body.transactionNumber)).size).toBe(5);
    });
  });

  describe('collecting a credit sale', () => {
    it('lets only one of two simultaneous full payments through (was: both, paid twice)', async () => {
      const sale = await creditSale();
      const results = await Promise.all([collect(sale.id, sale.total), collect(sale.id, sale.total)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      const { rows } = await db.query(`SELECT COALESCE(SUM(amount), 0) AS paid FROM transaction_payments WHERE transaction_id = $1`, [sale.id]);
      expect(Number(rows[0].paid)).toBeCloseTo(sale.total, 2);
    });
  });

  describe('voiding', () => {
    it('refuses a sale from an earlier day; that is a return (was: 200)', async () => {
      const sale = (await sell()).body;
      await db.query(`UPDATE transactions SET created_at = created_at - interval '1 day' WHERE id = $1`, [sale.id]);
      expect((await as(api().get(`/api/v1/pos/transactions/${sale.id}`))).body.voidable).toBe(false);
      const res = await voidSale(sale.id);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('VOID_WINDOW_CLOSED');
    });

    it('refuses a sale with returned books, so they are not restocked twice (was: 200, restocked twice)', async () => {
      const sale = (await as(api().get(`/api/v1/pos/transactions/${(await sell()).body.id}`))).body;
      const returned = await as(api().post('/api/v1/returns'), manager).send({
        transactionId: Number(sale.id), refundMethod: 'cash', reason: 'Damaged',
        lines: [{ transactionLineItemId: Number(sale.lineItems[0].id), quantity: 1 }],
      });
      expect(returned.status).toBe(201);
      const before = await stock();
      const res = await voidSale(sale.id);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('TRANSACTION_HAS_RETURNS');
      expect(await stock()).toBe(before);
    });

    it('restores stock once when voided twice at the same moment (was: twice)', async () => {
      const sale = (await sell({ items: [{ bookId, quantity: 3 }], payments: [{ method: 'cash', amount: price * 3 }] })).body;
      const before = await stock();
      const results = await Promise.all([voidSale(sale.id), voidSale(sale.id)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      expect(await stock()).toBe(before + 3);
    });

    it('cancels a credit sale\'s receivable, which then reads as not collected (was: still owed)', async () => {
      const sale = await creditSale();
      expect((await voidSale(sale.id)).status).toBe(200);
      const rec = (await db.query(`SELECT status, outstanding_amount FROM receivables WHERE id = $1`, [sale.receivableId])).rows[0];
      expect([rec.status, Number(rec.outstanding_amount)]).toEqual(['Cancelled', 0]);
      const ref = (await db.query(`SELECT source_ref_id FROM receivables WHERE id = $1`, [sale.receivableId])).rows[0].source_ref_id;
      const row = (await getReceivablesExportRows({ branchId })).find((r) => r.order_reference === ref);
      expect(row?.collected_amount).toBe(0);
    });

    it('records the money handed back and gives store credit back', async () => {
      const before = Number((await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId])).rows[0].balance);
      const sale = (await sell({ customerId, payments: [{ method: 'store_credit', amount: 5 }, { method: 'cash', amount: price - 5 }] })).body;
      expect((await voidSale(sale.id)).status).toBe(200);
      const after = Number((await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId])).rows[0].balance);
      expect(after).toBeCloseTo(before, 2);
      const audit = await db.query(
        `SELECT meta FROM audit_logs WHERE entity_type = 'transaction' AND entity_id = $1 AND meta->>'action' = 'void'`,
        [sale.id],
      );
      expect(audit.rows[0].meta.paymentsReturned).toEqual({ store_credit: 5, cash: Number((price - 5).toFixed(2)) });
    });
  });

  describe('sales history', () => {
    it('is for the roles that sell, take returns or collect (was: any signed-in staff member)', async () => {
      const sale = (await sell()).body;
      for (const path of ['/api/v1/pos/transactions', `/api/v1/pos/transactions/${sale.id}`]) {
        expect((await as(api().get(path), clerk)).status).toBe(403);
        expect((await as(api().get(path))).status).toBe(200);
      }
    });

    it('includes the last day of a date range (was: left out)', async () => {
      const sale = (await sell()).body;
      const today = (await db.query(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0].d;
      const res = await as(api().get(`/api/v1/pos/transactions?dateFrom=${today}&dateTo=${today}&pageSize=100`));
      expect(res.body.items.map((t: { id: string }) => t.id)).toContain(sale.id);
    });
  });
});
