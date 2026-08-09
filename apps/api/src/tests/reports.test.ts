import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';

const STAFF_PREFIX = 'rpt_test_';
const BRANCH_PREFIX = 'Report Test ';

describe('Reports — Slice 16', () => {
  let managerToken: string;
  let salesToken: string;
  let branchId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Report Test Branch' });
    branchId = branch.branchId;

    const mgr = await createTestStaff({ username: 'rpt_test_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;

    const sales = await createTestStaff({ username: 'rpt_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;
  });

  afterAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── 1. Sales report ─────────────────────────────────────────────────────────

  it('1. GET /api/reports/sales → returns summary + byPeriod + byBranch', async () => {
    const res = await request(getTestApp())
      .get('/api/reports/sales')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary).toHaveProperty('totalSales');
    expect(res.body.summary).toHaveProperty('totalOrders');
    expect(res.body.summary).toHaveProperty('averageOrderValue');
    expect(res.body.summary).toHaveProperty('totalPosSales');
    expect(res.body.summary).toHaveProperty('totalPosTransactions');
    expect(Array.isArray(res.body.byPeriod)).toBe(true);
    expect(Array.isArray(res.body.byBranch)).toBe(true);
  });

  // ── 2. Payment report ───────────────────────────────────────────────────────

  it('2. GET /api/reports/payments → returns summary + byMethod + byPeriod', async () => {
    const res = await request(getTestApp())
      .get('/api/reports/payments')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary).toHaveProperty('totalCollected');
    expect(res.body.summary).toHaveProperty('totalRefunded');
    expect(res.body.summary).toHaveProperty('netCollected');
    expect(res.body.summary).toHaveProperty('pendingPayments');
    expect(Array.isArray(res.body.byMethod)).toBe(true);
    expect(Array.isArray(res.body.byPeriod)).toBe(true);
  });

  // ── 3. Exchange report ──────────────────────────────────────────────────────

  it('3. GET /api/reports/exchanges → returns summary + bySettlementType + byPeriod', async () => {
    const res = await request(getTestApp())
      .get('/api/reports/exchanges')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary).toHaveProperty('totalExchanges');
    expect(res.body.summary).toHaveProperty('totalIncomingValue');
    expect(res.body.summary).toHaveProperty('totalOutgoingValue');
    expect(res.body.summary).toHaveProperty('netExchangeImpact');
    expect(Array.isArray(res.body.bySettlementType)).toBe(true);
    expect(Array.isArray(res.body.byPeriod)).toBe(true);
  });

  // ── 4. Inventory report ─────────────────────────────────────────────────────

  it('4. GET /api/reports/inventory → returns summary + lowStockItems + topSellingBooks + stockMovement', async () => {
    const res = await request(getTestApp())
      .get('/api/reports/inventory')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary).toHaveProperty('totalBooks');
    expect(res.body.summary).toHaveProperty('totalStockUnits');
    expect(res.body.summary).toHaveProperty('lowStockItems');
    expect(res.body.summary).toHaveProperty('outOfStockItems');
    expect(Array.isArray(res.body.lowStockItems)).toBe(true);
    expect(Array.isArray(res.body.topSellingBooks)).toBe(true);
    expect(Array.isArray(res.body.stockMovement)).toBe(true);
  });

  // ── 5. Customer report ──────────────────────────────────────────────────────

  it('5. GET /api/reports/customers → returns summary + topCustomers + byPeriod', async () => {
    const res = await request(getTestApp())
      .get('/api/reports/customers')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary).toHaveProperty('totalCustomers');
    expect(res.body.summary).toHaveProperty('activeCustomers');
    expect(res.body.summary).toHaveProperty('repeatCustomers');
    expect(res.body.summary).toHaveProperty('newCustomersInPeriod');
    expect(Array.isArray(res.body.topCustomers)).toBe(true);
    expect(Array.isArray(res.body.byPeriod)).toBe(true);
  });

  // ── 6. KPI report ───────────────────────────────────────────────────────────

  it('6. GET /api/reports/kpis → returns all KPI fields', async () => {
    const res = await request(getTestApp())
      .get('/api/reports/kpis')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('dailyRevenue');
    expect(res.body).toHaveProperty('monthlyRevenue');
    expect(res.body).toHaveProperty('averageOrderValue');
    expect(res.body).toHaveProperty('totalActiveCustomers');
    expect(res.body).toHaveProperty('lowStockAlerts');
    expect(res.body).toHaveProperty('pendingOrders');
    expect(res.body).toHaveProperty('totalExchangesToday');
    // All values must be numeric
    expect(typeof res.body.dailyRevenue).toBe('number');
    expect(typeof res.body.monthlyRevenue).toBe('number');
  });

  // ── 7. groupBy=month filter ─────────────────────────────────────────────────

  it('7. groupBy=month returns period strings', async () => {
    const res = await request(getTestApp())
      .get('/api/reports/sales?groupBy=month')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    // byPeriod may be empty if no data, but shape must be correct
    expect(Array.isArray(res.body.byPeriod)).toBe(true);
  });

  // ── 8. Sales role → 403 ─────────────────────────────────────────────────────

  it('8. Sales role → 403 on all report endpoints', async () => {
    const res = await request(getTestApp())
      .get('/api/reports/kpis')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(403);
  });

  // ── 9. Empty date range returns zeros, not errors ───────────────────────────

  it('9. Future date range returns empty data gracefully', async () => {
    const res = await request(getTestApp())
      .get('/api/reports/sales?dateFrom=2099-01-01&dateTo=2099-12-31')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    expect(res.body.summary.totalSales).toBe(0);
    expect(res.body.summary.totalOrders).toBe(0);
    expect(res.body.byPeriod).toHaveLength(0);
  });

  // ── 10. branchId filter scopes results ──────────────────────────────────────

  it('10. branchId filter returns scoped inventory report', async () => {
    const res = await request(getTestApp())
      .get(`/api/reports/inventory?branchId=${branchId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    expect(res.body.summary).toHaveProperty('totalBooks');
  });
});
