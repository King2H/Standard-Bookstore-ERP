import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff, setBranchPrice } from './helpers/seed.js';
import { db } from '../db/index.js';

// Exchanges after the move to the layered structure (#21). Each test names
// what the endpoint did before.

const STAFF_PREFIX = 'excrule_test_';
const BRANCH_PREFIX = 'Exc Rule ';
const CUSTOMER_CODE = 'EXCRULE-001';
const BOOK_ISBN = '9780000099017';

interface Exchange {
  id: string;
  exchangeReference: string;
  status: string;
  settlementType: string;
  netBalance: number;
  totalOutgoingValue: number;
  refundMethod: string | null;
  voidable: boolean;
  outstandingAmount: number;
  settlementEntries: Array<{ entryType: string; amount: number; method: string | null }>;
}

describe('Exchanges', () => {
  let branchId: number;
  let locationId: number;
  let customerId: number;
  let bookA: number;
  let bookB: number;
  let unpriced: number;
  let sales: string;
  let manager: string;
  let clerk: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = sales) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const stock = async (bookId: number) =>
    one(`SELECT quantity, damaged_quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
  const storeCredit = async () => Number((await one(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId])).balance);
  const receivableOf = (id: string) => one(`SELECT outstanding_amount, status FROM receivables WHERE source_type = 'exchange_difference' AND source_entity_id = $1`, [id]);

  /** Both books are priced 100 here: in A worth 40, out B → the customer owes 60. */
  function exchange(body: Record<string, unknown> = {}, token = sales) {
    return as(api().post('/api/v1/exchanges'), token).send({
      locationId,
      customerId,
      incomingItems: [{ bookId: bookA, quantity: 1, unitPrice: 40 }],
      outgoingItems: [{ bookId: bookB, quantity: 1 }],
      ...body,
    });
  }
  const voidIt = (id: string, token = manager, reason = 'Wrong books') =>
    as(api().post(`/api/v1/exchanges/${id}/void`), token).send({ reason });

  async function cleanUp() {
    const customer = `SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`;
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    for (const statement of [
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchange_settlement_entries WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchange_incoming_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchange_outgoing_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchanges WHERE branch_id IN (${branches})`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM store_credit_history WHERE customer_id IN (${customer})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customer})`,
      `DELETE FROM loyalty_history WHERE customer_id IN (${customer})`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (${customer})`,
      `DELETE FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`,
      `DELETE FROM books WHERE isbn = '${BOOK_ISBN}'`,
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
    locationId = (await one(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Exc Rule Loc', true) RETURNING id`,
      [branchId],
    )).id;
    const books = (await db.query(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 2`)).rows;
    bookA = books[0].id;
    bookB = books[1].id;
    unpriced = (await one(`INSERT INTO books (isbn, title, is_active) VALUES ($1, 'Exc Rule Unpriced', true) RETURNING id`, [BOOK_ISBN])).id;
    for (const b of [bookA, bookB]) {
      await setBranchPrice(b, branchId, 100);
      await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 100, 5, 0)`, [b, locationId]);
    }
    customerId = (await one(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Exc Rule Customer', $1, true) RETURNING id`,
      [CUSTOMER_CODE],
    )).id;
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 1000)`, [customerId]);
  });

  afterAll(cleanUp);

  describe('when the customer owes the difference', () => {
    it('takes payment at the counter, no receivable (was: always a receivable)', async () => {
      const res = await exchange({ payments: [{ method: 'cash', amount: 60 }] });
      expect(res.status).toBe(201);
      expect(res.body.settlementType).toBe('Customer_Pays');
      expect(res.body.settlementEntries).toEqual([expect.objectContaining({ entryType: 'cash_payment', amount: 60, method: 'cash' })]);
      expect(await receivableOf(res.body.id)).toBeUndefined();
    });

    it('writes no store-credit debit for money owed (was: a debit with no balance change)', async () => {
      const res = await exchange({ payments: [{ method: 'cash', amount: 60 }] });
      const history = await db.query(`SELECT 1 FROM store_credit_history WHERE ref_id = $1`, [res.body.exchangeReference]);
      expect(history.rows).toHaveLength(0);
    });

    it('leaves the rest on credit only when asked, with a receivable for it', async () => {
      const res = await exchange({ payments: [{ method: 'cash', amount: 20 }], allowCredit: true });
      expect(res.status).toBe(201);
      expect(Number((await receivableOf(res.body.id)).outstanding_amount)).toBe(40);
      expect(res.body.outstandingAmount).toBe(40);
    });

    it('refuses an exchange left unpaid without credit (was: 201, a receivable)', async () => {
      const res = await exchange();
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('PAYMENT_SUM_MISMATCH');
    });

    it('takes store credit from the account', async () => {
      const before = await storeCredit();
      const res = await exchange({ payments: [{ method: 'store_credit', amount: 60 }] });
      expect(res.status).toBe(201);
      expect(await storeCredit()).toBeCloseTo(before - 60, 2);
    });
  });

  describe('when the store owes the difference', () => {
    it('refunds cash, also with no customer (was: 422, store credit only)', async () => {
      const res = await exchange({
        customerId: null,
        incomingItems: [{ bookId: bookA, quantity: 2, unitPrice: 90 }],
        refundMethod: 'cash',
      });
      expect(res.status).toBe(201);
      expect(res.body.refundMethod).toBe('cash');
      expect(res.body.settlementEntries).toEqual([expect.objectContaining({ entryType: 'cash_refund', amount: 80, method: 'cash' })]);
    });

    it('gives store credit by default, which needs a customer', async () => {
      const before = await storeCredit();
      const res = await exchange({ incomingItems: [{ bookId: bookA, quantity: 2, unitPrice: 90 }] });
      expect(res.status).toBe(201);
      expect(res.body.refundMethod).toBe('store_credit');
      expect(await storeCredit()).toBeCloseTo(before + 80, 2);

      const anonymous = await exchange({ customerId: null, incomingItems: [{ bookId: bookA, quantity: 2, unitPrice: 90 }] });
      expect(anonymous.status).toBe(422);
      expect(anonymous.body.error).toBe('STORE_CREDIT_REQUIRES_CUSTOMER');
    });
  });

  describe('valuation', () => {
    it('prices outgoing books from the catalog (was: the price typed in)', async () => {
      const res = await exchange({ outgoingItems: [{ bookId: bookB, quantity: 1, unitPrice: 1 }], payments: [{ method: 'cash', amount: 60 }] });
      expect(res.status).toBe(201);
      expect(res.body.totalOutgoingValue).toBe(100);
    });

    it('holds a trade-in to its selling price (was: any value)', async () => {
      const res = await exchange({ incomingItems: [{ bookId: bookA, quantity: 1, unitPrice: 150 }] });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('TRADE_IN_ABOVE_PRICE');
    });

    it('above the approval limit, needs a Manager or Admin (was: anyone)', async () => {
      const big = { incomingItems: [{ bookId: bookA, quantity: 6, unitPrice: 100 }], outgoingItems: [], refundMethod: 'cash' };
      const refused = await exchange(big);
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('APPROVAL_REQUIRED');
      expect((await exchange(big, manager)).status).toBe(201);
    });

    it('lets only a Manager or Admin value a book with no price', async () => {
      const unpricedIn = { incomingItems: [{ bookId: unpriced, quantity: 1, unitPrice: 10 }], outgoingItems: [], refundMethod: 'cash' };
      expect((await exchange(unpricedIn)).body.error).toBe('APPROVAL_REQUIRED');
      expect((await exchange(unpricedIn, manager)).status).toBe(201);
    });

    it('refuses an inactive customer (was: 201)', async () => {
      await db.query(`UPDATE customers SET is_active = false WHERE id = $1`, [customerId]);
      try {
        const res = await exchange({ payments: [{ method: 'cash', amount: 60 }] });
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('CUSTOMER_INACTIVE');
      } finally {
        await db.query(`UPDATE customers SET is_active = true WHERE id = $1`, [customerId]);
      }
    });
  });

  describe('stock', () => {
    it('keeps a damaged trade-in apart from stock for sale (was: always resellable)', async () => {
      const before = await stock(bookA);
      const res = await exchange({
        incomingItems: [{ bookId: bookA, quantity: 1, unitPrice: 40, condition: 'damaged' }],
        payments: [{ method: 'cash', amount: 60 }],
      });
      expect(res.status).toBe(201);
      const after = await stock(bookA);
      expect(after.quantity).toBe(before.quantity);
      expect(after.damaged_quantity).toBe(before.damaged_quantity + 1);
    });

    it("records the books taken out as a sale (was: 'loss')", async () => {
      const res = await exchange({ payments: [{ method: 'cash', amount: 60 }] });
      const row = await one(
        `SELECT reason_code FROM inventory_history WHERE reference_type = 'exchange_out' AND reference_id = $1`,
        [res.body.id],
      );
      expect(row.reason_code).toBe('sale');
    });
  });

  describe('voiding', () => {
    it('undoes an exchange on its day: stock both ways, money back, store credit taken back (was: no way to)', async () => {
      const [a0, b0] = [await stock(bookA), await stock(bookB)];
      const credit0 = await storeCredit();
      const made = await exchange({ payments: [{ method: 'store_credit', amount: 30 }, { method: 'cash', amount: 10 }], allowCredit: true });
      expect(made.status).toBe(201);
      expect(made.body.voidable).toBe(true);

      expect((await voidIt(made.body.id, sales)).status).toBe(403);
      const res = await voidIt(made.body.id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Cancelled');
      expect(res.body.voidReason).toBe('Wrong books');
      expect(await stock(bookA)).toEqual(a0);
      expect(await stock(bookB)).toEqual(b0);
      expect(await storeCredit()).toBeCloseTo(credit0, 2);
      expect((await receivableOf(made.body.id)).status).toBe('Cancelled');

      const again = await voidIt(made.body.id);
      expect(again.status).toBe(422);
      expect(again.body.error).toBe('ALREADY_VOIDED');
    });

    it('takes back store credit it gave only while unspent', async () => {
      const made = await exchange({ incomingItems: [{ bookId: bookA, quantity: 2, unitPrice: 90 }] });
      const balance = await storeCredit();
      await db.query(`UPDATE store_credit_accounts SET balance = 10 WHERE customer_id = $1`, [customerId]);
      try {
        const res = await voidIt(made.body.id);
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('STORE_CREDIT_SPENT');
      } finally {
        await db.query(`UPDATE store_credit_accounts SET balance = $2 WHERE customer_id = $1`, [customerId, balance]);
      }
    });

    it('is refused after the day of the exchange', async () => {
      const made = await exchange({ payments: [{ method: 'cash', amount: 60 }] });
      await db.query(`UPDATE exchanges SET created_at = now() - interval '2 days' WHERE id = $1`, [made.body.id]);
      const res = await voidIt(made.body.id);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('VOID_WINDOW_CLOSED');
    });
  });

  describe('records', () => {
    it('is not for roles that do not sell (was: any signed-in role)', async () => {
      expect((await as(api().get('/api/v1/exchanges'), clerk)).status).toBe(403);
    });

    it('lists the exchanges of the last day asked for (was: dateTo left that day out)', async () => {
      const made = await exchange({ payments: [{ method: 'cash', amount: 60 }] });
      const { today } = await one(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
      const res = await as(api().get(`/api/v1/exchanges?dateFrom=${today}&dateTo=${today}&pageSize=100`));
      expect(res.status).toBe(200);
      expect(res.body.items.map((e: Exchange) => e.id)).toContain(made.body.id);
    });

    it('numbers exchanges made at the same moment differently', async () => {
      const results = await Promise.all([1, 2, 3].map(() => exchange({ payments: [{ method: 'cash', amount: 60 }] })));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(new Set(results.map((r) => r.body.exchangeReference)).size).toBe(3);
    });
  });
});
