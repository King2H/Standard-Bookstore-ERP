// #234 (#225 G3–G6; owner decisions 1a–4a, 2026-11-04): each role reads what
// its work needs. Sales and money reports for those who handle money; stock
// and procurement reports also for the Purchasor (G4). What stock cost only
// for VIEW_COST (G5). Customers and customer orders only for those who sell
// or take payments (G6). A Manager adds staff to their own branch (G3).
// Before, a Purchasor read every report, a Sales or Stock_Clerk account every
// cost, any signed-in account every customer, and only Admins added staff.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'permsplit_';
const BRANCH_PREFIX = 'Perm Split ';
const PASSWORD = 'Strong#Pass2026';

type Who = 'manager' | 'finance' | 'purchasor' | 'clerk' | 'sales' | 'superAdmin';

describe('Permissions by work (#234)', () => {
  let branchA: number;
  let branchB: number;
  let bookId: number;
  let customerId: number;
  const tokens = {} as Record<Who, string>;
  const as = (who: Who) => ({
    get: (path: string) => request(getTestApp()).get(path).set('Authorization', `Bearer ${tokens[who]}`).set('X-Branch-Id', String(branchA)),
    post: (path: string, body: object = {}) =>
      request(getTestApp()).post(path).set('Authorization', `Bearer ${tokens[who]}`).set('X-Branch-Id', String(branchA)).send(body),
  });
  const status = async (who: Who, path: string) => (await as(who).get(path)).status;

  async function cleanUp() {
    const locations = `SELECT id FROM locations WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%')`;
    await db.query(`DELETE FROM inventory WHERE location_id IN (${locations})`);
    await cleanTestStaff(STAFF_PREFIX);
    await db.query(`DELETE FROM staff WHERE lower(username) LIKE $1`, [`${STAFF_PREFIX}%`]);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    const location = (await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Perm shelf', true) RETURNING id`, [branchA])).rows[0].id;
    bookId = (await db.query(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 1`)).rows[0].id;
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost, damaged_quantity, damaged_value) VALUES ($1, $2, 5, 12.5, 1, 12.5)`, [bookId, location]);
    customerId = (await db.query(`SELECT id FROM customers ORDER BY id LIMIT 1`)).rows[0]?.id ?? 1;
    const roles: Record<Who, Parameters<typeof createTestStaff>[0]['role']> = {
      manager: 'Manager', finance: 'Finance_Officer', purchasor: 'Purchasor', clerk: 'Stock_Clerk', sales: 'Sales', superAdmin: 'Super_Admin',
    };
    for (const [who, role] of Object.entries(roles) as [Who, typeof roles[Who]][]) {
      tokens[who] = (await createTestStaff({ username: `${STAFF_PREFIX}${who.toLowerCase()}`, role, branchId: branchA })).token;
    }
  });

  afterAll(cleanUp);

  describe('reports (G4, 1a)', () => {
    it('keeps sales and money reports from the Purchasor (was: every report)', async () => {
      for (const path of ['/api/v1/reports/sales', '/api/v1/reports/kpis', '/api/v1/reports/payments', '/api/v1/reports/customers', '/api/v1/financial-transactions', '/api/v1/business-days']) {
        expect(await status('purchasor', path), path).toBe(403);
      }
    });

    it('still gives the Purchasor the stock and procurement reports', async () => {
      expect(await status('purchasor', '/api/v1/reports/inventory')).toBe(200);
      expect(await status('purchasor', '/api/v1/reports/procurement/open-pos')).toBe(200);
      expect(await status('purchasor', '/api/v1/reports/procurement/purchases-by-supplier')).toBe(200);
    });

    it('gives both kinds to those who read reports, and neither to the counter and the stockroom', async () => {
      for (const who of ['manager', 'finance', 'superAdmin'] as const) {
        expect(await status(who, '/api/v1/reports/sales'), who).toBe(200);
        expect(await status(who, '/api/v1/reports/inventory'), who).toBe(200);
      }
      for (const who of ['sales', 'clerk'] as const) {
        expect(await status(who, '/api/v1/reports/inventory'), who).toBe(403);
        expect(await status(who, '/api/v1/reports/procurement/open-pos'), who).toBe(403);
      }
    });
  });

  describe('cost (G5, 2a)', () => {
    const level = async (who: Who) => (await as(who).get(`/api/v1/inventory?bookId=${bookId}`)).body.items[0];

    it('leaves cost and value out for Sales and the Stock_Clerk (was: shown)', async () => {
      for (const who of ['sales', 'clerk'] as const) {
        expect(await level(who), who).toMatchObject({ quantity: 5, averageCost: null, damaged: 1, damagedValue: null });
      }
    });

    it('shows them to those with VIEW_COST', async () => {
      for (const who of ['manager', 'finance', 'purchasor'] as const) {
        expect(await level(who), who).toMatchObject({ averageCost: 12.5, damagedValue: 12.5 });
      }
    });

    it('leaves them out of the answer to a stock movement too', async () => {
      const { locationId, version } = await level('clerk');
      const res = await as('clerk').post('/api/v1/inventory/stock-in', { bookId, locationId, version, quantity: 1, unitCost: '12.50', referenceType: 'manual', notes: 'perm test' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ quantity: 6, averageCost: null, damagedValue: null });
    });
  });

  describe('customers and customer orders (G6, 3a)', () => {
    const reads = () => [
      '/api/v1/customers', `/api/v1/customers/${customerId}`, '/api/v1/customer-groups',
      `/api/v1/customers/${customerId}/loyalty`, `/api/v1/customers/${customerId}/store-credit`,
      `/api/v1/customers/${customerId}/loyalty/history`, `/api/v1/customers/${customerId}/store-credit/history`, '/api/v1/orders',
    ];

    it('keeps them from the stockroom and the Purchasor (was: open to any signed-in account)', async () => {
      for (const who of ['clerk', 'purchasor'] as const) {
        for (const path of reads()) expect(await status(who, path), `${who} ${path}`).toBe(403);
      }
    });

    it('gives them to those who sell or take payments', async () => {
      for (const who of ['sales', 'finance', 'manager'] as const) {
        expect(await status(who, '/api/v1/customers'), who).toBe(200);
        expect(await status(who, '/api/v1/orders'), who).toBe(200);
      }
    });

    it('still names the customer of a special order to the Purchasor', async () => {
      expect(await status('purchasor', '/api/v1/special-orders')).toBe(200);
    });
  });

  describe('a Manager adds staff (G3, 4a)', () => {
    const add = (username: string, roles: Array<{ branchId: number; role: string }>, extra: object = {}) =>
      as('manager').post('/api/v1/staff', { username: `${STAFF_PREFIX}${username}`, password: PASSWORD, fullName: 'New Hire', roles, ...extra });

    it('to their own branch, with a role they manage; the new account changes its password first, and the addition is audited (was: 403)', async () => {
      const res = await add('hire1', [{ branchId: branchA, role: 'Sales' }, { branchId: branchA, role: 'Stock_Clerk' }]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row = (await db.query(`SELECT must_change_password FROM staff WHERE id = $1`, [res.body.staffId])).rows[0];
      expect(row.must_change_password).toBe(true);
      const audit = await db.query(`SELECT action FROM audit_logs WHERE entity_type = 'staff' AND entity_id = $1`, [String(res.body.staffId)]);
      expect(audit.rows.map((r) => r.action)).toContain('CREATE');
      const login = await request(getTestApp()).post('/api/v1/auth/login').send({ username: `${STAFF_PREFIX}hire1`, password: PASSWORD, branchId: branchA });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      expect(login.body.mustChangePassword).toBe(true);
    });

    it('not with a role at or above their own', async () => {
      expect((await add('hire2', [{ branchId: branchA, role: 'Manager' }])).status).toBe(403);
      expect((await add('hire3', [{ branchId: branchA, role: 'Admin' }])).status).toBe(403);
    });

    it('not to another branch, nor without a role, nor with access to all branches', async () => {
      expect((await add('hire4', [{ branchId: branchB, role: 'Sales' }])).status).toBe(403);
      expect((await add('hire5', [])).status).toBe(403);
      expect((await add('hire6', [{ branchId: branchA, role: 'Sales' }], { isAllBranches: true })).status).toBe(403);
      expect((await db.query(`SELECT count(*)::int AS n FROM staff WHERE lower(username) IN ($1, $2, $3, $4, $5)`,
        ['hire2', 'hire3', 'hire4', 'hire5', 'hire6'].map((u) => `${STAFF_PREFIX}${u}`))).rows[0].n).toBe(0);
    });

    it('not for anyone else below Admin', async () => {
      for (const who of ['sales', 'finance', 'clerk'] as const) {
        const res = await as(who).post('/api/v1/staff', { username: `${STAFF_PREFIX}x${who}`, password: PASSWORD, fullName: 'X', roles: [{ branchId: branchA, role: 'Sales' }] });
        expect(res.status, who).toBe(403);
      }
    });
  });
});
