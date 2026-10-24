import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { CustomerReportSchema, InventoryReportSchema, ReceivablesAgingSchema } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #22, part 2: the inventory, customer and receivables reports on the
// layered structure. A date range includes its last day in full (the stock
// and customer reports compared timestamps with midnight of dateTo), and a
// customer's spend counts only sales: orders confirmed or later (owner
// decision 3a).

const STAFF_PREFIX = 'rptstock_test_';
const BRANCH_PREFIX = 'Report Stock ';
const CUSTOMER_PREFIX = 'RPTSTOCK-';

describe('Inventory, customer and receivables reports', () => {
  let branchId: number;
  let staffId: number;
  let token: string;
  let bookId: number;
  let today: string;
  let buyer: number;
  let browser: number;
  const api = () => request(getTestApp());
  const get = (path: string) => api().get(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));

  async function customer(code: string): Promise<number> {
    return (await db.query(
      `INSERT INTO customers (full_name, customer_code, is_active, branch_id) VALUES ($1, $1, true, $2) RETURNING id`,
      [`${CUSTOMER_PREFIX}${code}`, branchId],
    )).rows[0].id;
  }

  async function order(customerId: number, number: string, status: string, total: number): Promise<void> {
    await db.query(
      `INSERT INTO orders (order_number, branch_id, created_by, customer_id, status, subtotal, total, currency) VALUES ($1, $2, $3, $4, $5, $6, $6, 'ETB')`,
      [number, branchId, staffId, customerId, status, total],
    );
  }

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const sales = `SELECT id FROM transactions WHERE branch_id IN (${branches})`;
    for (const statement of [
      `DELETE FROM transaction_payments WHERE transaction_id IN (${sales})`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (${sales})`,
      `DELETE FROM transactions WHERE id IN (${sales})`,
      `DELETE FROM orders WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (SELECT id FROM customers WHERE customer_code LIKE '${CUSTOMER_PREFIX}%')`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (SELECT id FROM customers WHERE customer_code LIKE '${CUSTOMER_PREFIX}%')`,
      `DELETE FROM customers WHERE customer_code LIKE '${CUSTOMER_PREFIX}%'`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    today = (await db.query(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0].d;
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    const staff = await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId });
    staffId = staff.staffId;
    token = staff.token;
    const locationId = (await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Report Stock Loc', true) RETURNING id`,
      [branchId],
    )).rows[0].id;
    const book = (await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 0 ORDER BY id LIMIT 1`)).rows[0];
    bookId = book.id;
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 20, 0, 0)`, [bookId, locationId]);
    const sale = await api().post('/api/v1/pos/transactions').set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId, quantity: 2 }], payments: [{ method: 'cash', amount: Number(book.default_price) * 2 }] });
    expect(sale.status).toBe(201);

    buyer = await customer('BUYER');
    browser = await customer('BROWSER');
    await order(buyer, 'RPTSTOCK-1', 'CONFIRMED', 200);
    await order(buyer, 'RPTSTOCK-2', 'COMPLETED', 100);
    await order(browser, 'RPTSTOCK-3', 'DRAFT', 1000);
    await order(browser, 'RPTSTOCK-4', 'CANCELLED', 500);
  });

  afterAll(cleanUp);

  describe('a range ending today includes today', () => {
    it('lists today\'s POS sales among the best sellers (was: left out)', async () => {
      const res = await get(`/api/v1/reports/inventory?dateFrom=${today}&dateTo=${today}`);
      expect(res.status).toBe(200);
      expect(res.body.topSellingBooks).toEqual([expect.objectContaining({ bookId, unitsSold: 2 })]);
    });

    it('counts today\'s stock movement (was: empty)', async () => {
      const res = await get(`/api/v1/reports/inventory?dateFrom=${today}&dateTo=${today}`);
      expect(res.body.stockMovement).toEqual([expect.objectContaining({ stockOut: 2 })]);
    });

    it('counts customers registered today (was: 0)', async () => {
      const res = await get(`/api/v1/reports/customers?dateFrom=${today}&dateTo=${today}`);
      expect(res.body.summary.newCustomersInPeriod).toBe(2);
      expect(res.body.byPeriod).toEqual([expect.objectContaining({ newCustomers: 2 })]);
    });
  });

  describe('a customer\'s sales', () => {
    it('ranks customers by sales only (was: drafts and cancelled orders added to their spend)', async () => {
      const res = await get('/api/v1/reports/customers');
      expect(res.body.topCustomers).toEqual([{ customerId: buyer, fullName: `${CUSTOMER_PREFIX}BUYER`, totalSpend: 300, orderCount: 2 }]);
    });

    it('counts a repeat customer by sales only (was: two drafts made one)', async () => {
      const res = await get('/api/v1/reports/customers');
      expect(res.body.summary.repeatCustomers).toBe(1);
      await order(browser, 'RPTSTOCK-5', 'DRAFT', 10);
      expect((await get('/api/v1/reports/customers')).body.summary.repeatCustomers).toBe(1);
    });
  });

  describe('contracts', () => {
    it('answers with the shared schemas', async () => {
      const cases: [string, { parse: (v: unknown) => unknown }][] = [
        ['/api/v1/reports/inventory?groupBy=week', InventoryReportSchema.strict()],
        ['/api/v1/reports/customers?groupBy=month', CustomerReportSchema.strict()],
        ['/api/v1/reports/receivables-aging', ReceivablesAgingSchema.strict()],
      ];
      for (const [path, schema] of cases) {
        const res = await get(path);
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
        expect(schema.parse(res.body)).toEqual(res.body);
      }
    });

    it.each([
      '/api/v1/reports/inventory/export',
      '/api/v1/reports/inventory-valuation/export',
      '/api/v1/reports/customers/export',
      '/api/v1/reports/receivables-aging/export',
      '/api/v1/reports/receivables/export',
    ])('still exports %s as CSV', async (path) => {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
    });

    it('refuses an impossible date with 400 (was: 500)', async () => {
      const res = await get('/api/v1/reports/customers?dateTo=2026-02-30');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });
});
