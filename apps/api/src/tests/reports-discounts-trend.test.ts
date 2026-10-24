import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { GrossProfitTrendSchema, SalesReportSchema } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Dashboard part 2 (#23): the sales report gives its discounts by preset type
// (owner decision 1a; the Discount Summary read fields the API never sent),
// and the gross profit trend follows the requested bucket (3a; it was always
// daily).

const STAFF_PREFIX = 'rptdisc_test_';
const BRANCH_PREFIX = 'Report Discounts ';

describe('Sales report: discounts by preset type and the trend buckets', () => {
  let branchId: number;
  let staffId: number;
  let token: string;
  let bookId: number;
  const api = () => request(getTestApp());
  const get = (path: string) => api().get(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));

  async function order(number: string, status: string, lines: Array<{ price: number; discount: number; type: string }>): Promise<void> {
    const total = lines.reduce((sum, l) => sum + l.price - l.discount, 0);
    const id = (await db.query(
      `INSERT INTO orders (order_number, branch_id, created_by, status, subtotal, total, currency) VALUES ($1, $2, $3, $4, $5, $5, 'ETB') RETURNING id`,
      [number, branchId, staffId, status, total],
    )).rows[0].id;
    for (const l of lines) {
      await db.query(
        `INSERT INTO order_line_items (order_id, book_id, quantity, unit_price, discount_amount, discount_type, total_price, unit_cost)
         VALUES ($1, $2, 1, $3, $4, $5, $6, 0)`,
        [id, bookId, l.price, l.discount, l.type, l.price - l.discount],
      );
    }
  }

  async function cleanUp() {
    const orders = `SELECT id FROM orders WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%')`;
    await db.query(`DELETE FROM order_line_items WHERE order_id IN (${orders})`);
    await db.query(`DELETE FROM orders WHERE id IN (${orders})`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    const staff = await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId });
    staffId = staff.staffId;
    token = staff.token;
    bookId = (await db.query(`SELECT id FROM books ORDER BY id LIMIT 1`)).rows[0].id;
    await order('RPTD-CONF-1', 'CONFIRMED', [
      { price: 100, discount: 5, type: 'Normal' },
      { price: 100, discount: 20, type: 'Special' },
    ]);
    await order('RPTD-DONE-1', 'COMPLETED', [{ price: 80, discount: 7.5, type: 'Merchant' }]);
    // Not sales: their discounts are left out like their amounts.
    await order('RPTD-DRAFT-1', 'DRAFT', [{ price: 500, discount: 100, type: 'Merchant' }]);
    await order('RPTD-CANC-1', 'CANCELLED', [{ price: 500, discount: 100, type: 'Special' }]);
  });

  afterAll(cleanUp);

  it('gives the discounts by preset type, adding up to the discounts (was: not sent, so the Discount Summary never showed)', async () => {
    const res = await get('/api/v1/reports/sales');
    expect(res.status).toBe(200);
    expect(res.body.summary.discountsByType).toEqual({ Normal: 5, Merchant: 7.5, Special: 20 });
    expect(res.body.summary.discounts).toBe(32.5);
    expect(SalesReportSchema.strict().parse(res.body)).toEqual(res.body);
  });

  it('groups the gross profit trend by week or month as asked (was: always by day)', async () => {
    const { day, week, month } = (await db.query(
      `SELECT TO_CHAR(now(), 'YYYY-MM-DD') AS day,
              TO_CHAR(date_trunc('week', now()), 'YYYY-MM-DD') AS week,
              TO_CHAR(date_trunc('month', now()), 'YYYY-MM-DD') AS month`,
    )).rows[0];
    const expected = { netSales: 247.5, grossProfit: 247.5, grossMarginPct: 100 };
    for (const [groupBy, period] of [['day', day], ['week', week], ['month', month]]) {
      const res = await get(`/api/v1/reports/sales/gross-profit-trend?groupBy=${groupBy}`);
      expect(res.status).toBe(200);
      expect({ groupBy, body: res.body }).toEqual({ groupBy, body: [{ period, ...expected }] });
      expect(GrossProfitTrendSchema.parse(res.body)).toEqual(res.body);
    }
  });
});
