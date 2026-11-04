// #230 (#225 K5, S2; owner decision 3a, 2026-11-04): one rule for low stock,
// everywhere: "low" is above 0 and at or below the reorder point, "out" is 0
// or less. Before, the KPIs counted a book with none left as low, the
// inventory report said low or out (missing a negative count), and its list
// called every one of them low.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'stockalert_';
const BRANCH_PREFIX = 'Stock Alerts ';

describe('Low and out of stock (#230)', () => {
  let branchId: number;
  let manager: string;
  const books: number[] = [];
  const get = (path: string) => request(getTestApp()).get(path).set('Authorization', `Bearer ${manager}`).set('X-Branch-Id', String(branchId));

  async function cleanUp() {
    const locations = `SELECT id FROM locations WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%')`;
    await db.query(`DELETE FROM inventory WHERE location_id IN (${locations})`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    const location = (await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Alerts shelf', true) RETURNING id`, [branchId])).rows[0].id;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    books.push(...(await db.query(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 4`)).rows.map((r) => r.id as number));
    // Out (0), low (2 of 5), out (below zero), fine (10 of 5).
    for (const [i, quantity, reorder] of [[0, 0, 5], [1, 2, 5], [2, -1, 0], [3, 10, 5]] as const) {
      await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, average_cost) VALUES ($1, $2, $3, $4, 1)`, [books[i], location, quantity, reorder]);
    }
  });

  afterAll(cleanUp);

  it('counts low and out apart, the same way in the KPIs and the inventory report (was: out counted as low)', async () => {
    const kpis = (await get('/api/v1/reports/kpis')).body;
    expect(kpis).toMatchObject({ lowStockItems: 1, outOfStockItems: 2 });
    expect(kpis).not.toHaveProperty('lowStockAlerts');
    const report = (await get('/api/v1/reports/inventory')).body;
    expect(report.summary).toMatchObject({ lowStockItems: 1, outOfStockItems: 2 });
  });

  it('lists each book needing stock as low or out (was: all "low")', async () => {
    const report = (await get('/api/v1/reports/inventory')).body;
    const alerts = Object.fromEntries(report.stockAlerts.map((a: { bookId: number; status: string }) => [a.bookId, a.status]));
    expect(alerts).toEqual({ [books[0]]: 'out', [books[1]]: 'low', [books[2]]: 'out' });
    expect(report).not.toHaveProperty('lowStockItems');
  });
});
