// #230 (#225 M5; owner decision 2a, 2026-11-04): Payment History lists every
// POS payment, taken at the sale or collected later, under the sale's own
// number and method, "voided" when its sale was voided. Before, only the
// payments of credit sales were listed, a voided sale's as "success", under
// made-up PAY-POS- references.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'payhist_pos_';
const BRANCH_PREFIX = 'PayHist POS ';
const CODE = 'PAYHIST-POS';

describe('Payment History: POS payments (#230)', () => {
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let price: number;
  let customerId: number;
  let sales: string;
  let manager: string;
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const as = (token: string) => ({
    get: (path: string) => request(getTestApp()).get(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId)),
    post: (path: string, body: object = {}) =>
      request(getTestApp()).post(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId)).send(body),
  });
  const sell = async (body: object) => {
    const res = await as(sales).post('/api/v1/pos/transactions', { locationId, items: [{ bookId, quantity: 1 }], ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; transactionNumber: string };
  };
  const history = async () => (await as(manager).get('/api/v1/payments?pageSize=100')).body.items as Array<Record<string, unknown>>;

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const tx = `SELECT id FROM transactions WHERE branch_id IN (${branches})`;
    for (const statement of [
      `DELETE FROM cash_session_movements WHERE session_id IN (SELECT id FROM cash_sessions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transaction_payments WHERE transaction_id IN (${tx})`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (${tx})`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM customers WHERE customer_code = '${CODE}'`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => { if (err.code !== '42P01') throw err; });
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    locationId = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'PayHist shelf', true) RETURNING id`, [branchId])).id;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 0 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 20, 1)`, [bookId, locationId]);
    customerId = (await one(
      `INSERT INTO customers (branch_id, customer_code, full_name, is_active) VALUES ($1, $2, 'PayHist Customer', true) RETURNING id`, [branchId, CODE],
    )).id;
  });

  afterAll(cleanUp);

  it("lists a paid sale's payment under the sale's number, as success (was: not listed)", async () => {
    const sale = await sell({ payments: [{ method: 'mobile', amount: price, reference: 'TB-230' }] });
    const row = (await history()).find((p) => p.entityNumber === sale.transactionNumber);
    expect(row).toMatchObject({
      sourceType: 'pos', paymentReference: sale.transactionNumber, paymentMethod: 'mobile', status: 'success', amount: price, transactionReference: 'TB-230',
    });
  });

  it("lists a credit sale's payments, at the sale and collected later", async () => {
    const sale = await sell({ customerId, allowCredit: true, payments: [{ method: 'cash', amount: 1 }] });
    const collected = await as(sales).post(`/api/v1/pos/transactions/${sale.id}/payment`, { payments: [{ method: 'cash', amount: 1 }] });
    expect(collected.status, JSON.stringify(collected.body)).toBe(200);
    const rows = (await history()).filter((p) => p.entityNumber === sale.transactionNumber);
    expect(rows).toHaveLength(2);
    expect(rows.every((p) => p.status === 'success' && p.paymentReference === sale.transactionNumber)).toBe(true);
  });

  it("shows a voided sale's payments as voided: the money went back (was: success)", async () => {
    const sale = await sell({ customerId, allowCredit: true, payments: [{ method: 'cash', amount: 1 }] });
    expect((await as(manager).post(`/api/v1/pos/transactions/${sale.id}/void`)).status).toBe(200);
    const rows = (await history()).filter((p) => p.entityNumber === sale.transactionNumber);
    expect(rows.map((p) => p.status)).toEqual(['voided']);
    expect((await as(manager).get('/api/v1/payments?status=voided&pageSize=100')).body.items.map((p: { entityNumber: string }) => p.entityNumber))
      .toContain(sale.transactionNumber);
  });

  it('makes up no PAY-POS- references', async () => {
    expect((await history()).filter((p) => String(p.paymentReference).startsWith('PAY-POS-'))).toEqual([]);
  });
});
