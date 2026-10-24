import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  GrossProfitTrendSchema,
  KpiReportSchema,
  PeriodKpisSchema,
  SalesDetailResponseSchema,
  SalesReportSchema,
} from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #22, part 1: the sales and KPI reports on the layered structure. Orders
// count as sales once confirmed (owner decision 3a): a draft is a quote.
// Report queries are validated (they reached the database unchecked).

const STAFF_PREFIX = 'rptsales_test_';
const BRANCH_PREFIX = 'Report Sales ';

describe('Sales and KPI reports', () => {
  let branchId: number;
  let staffId: number;
  let token: string;
  let bookId: number;
  const api = () => request(getTestApp());
  const get = (path: string) => api().get(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));

  async function order(number: string, status: string, total: number): Promise<number> {
    const id = (await db.query(
      `INSERT INTO orders (order_number, branch_id, created_by, status, subtotal, total, currency) VALUES ($1, $2, $3, $4, $5, $5, 'ETB') RETURNING id`,
      [number, branchId, staffId, status, total],
    )).rows[0].id;
    await db.query(
      `INSERT INTO order_line_items (order_id, book_id, quantity, unit_price, total_price, unit_cost) VALUES ($1, $2, 1, $3, $3, 0)`,
      [id, bookId, total],
    );
    return id;
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
    await order('RPT-DRAFT-1', 'DRAFT', 1000);
    await order('RPT-CONF-1', 'CONFIRMED', 300);
    await order('RPT-DONE-1', 'COMPLETED', 200);
    await order('RPT-CANC-1', 'CANCELLED', 50);
  });

  afterAll(cleanUp);

  describe('what counts as a sale', () => {
    it('leaves draft orders out of the sales report (was: counted as sales)', async () => {
      const res = await get('/api/v1/reports/sales');
      expect(res.status).toBe(200);
      expect(res.body.summary).toMatchObject({ totalSales: 500, totalOrders: 2, averageOrderValue: 250 });
      expect(res.body.byBranch).toEqual([expect.objectContaining({ branchId, totalSales: 500, totalOrders: 2 })]);
    });

    it('leaves them out of the sales lines and the accrual figures', async () => {
      const detail = await get('/api/v1/reports/sales/detail');
      expect(detail.body.rows.map((r: { invoiceNo: string }) => r.invoiceNo).sort()).toEqual(['RPT-CONF-1', 'RPT-DONE-1']);
      expect(detail.body.totals.netSalesAmount).toBe(500);
      expect((await get('/api/v1/reports/sales')).body.summary.netSales).toBe(500);
    });

    it('leaves them out of the KPIs (was: in today\'s and this month\'s sales and the average order)', async () => {
      const res = await get('/api/v1/reports/kpis');
      expect(res.body).toMatchObject({ dailySales: 500, monthlySales: 500, averageOrderValue: 250, pendingOrders: 1, dailyNetSalesRevenue: 500 });
    });
  });

  describe('query validation', () => {
    it.each([
      ['an impossible date', '/api/v1/reports/sales?dateTo=2026-13-45'],
      ['a word for a date', '/api/v1/reports/sales?dateFrom=yesterday'],
      ['a range that ends before it starts', '/api/v1/reports/sales/detail?dateFrom=2026-10-11&dateTo=2026-10-01'],
      ['an unknown bucket', '/api/v1/reports/sales?groupBy=year'],
      ['an unknown period', '/api/v1/reports/kpis/period?period=decade'],
    ])('refuses %s with 400 (was: 500 or ignored)', async (_name, path) => {
      const res = await get(path);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('contracts', () => {
    it('answers with the shared schemas', async () => {
      const cases: [string, { strict?: () => unknown; parse: (v: unknown) => unknown }][] = [
        ['/api/v1/reports/sales?groupBy=month', SalesReportSchema.strict()],
        ['/api/v1/reports/sales/detail', SalesDetailResponseSchema.strict()],
        ['/api/v1/reports/sales/gross-profit-trend', GrossProfitTrendSchema],
        ['/api/v1/reports/kpis', KpiReportSchema.strict()],
        ['/api/v1/reports/kpis/period?period=month', PeriodKpisSchema.strict()],
      ];
      for (const [path, schema] of cases) {
        const res = await get(path);
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
        expect(schema.parse(res.body)).toEqual(res.body);
      }
    });

    it('still exports the sales lines as CSV with a totals row', async () => {
      const res = await get('/api/v1/reports/sales/export');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.text).toContain('RPT-CONF-1');
      expect(res.text).not.toContain('RPT-DRAFT-1');
      expect(res.text).toContain('TOTAL');
    });
  });
});
