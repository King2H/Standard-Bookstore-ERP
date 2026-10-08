import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Branch isolation (#12): branch-owned data is read through the session's
// branch, never through a branch the client names.

const STAFF_PREFIX = 'scope_test_';
const BRANCH_PREFIX = 'Scope Test Branch';

// Every list of branch-owned records, with a query that is valid for it.
const SCOPED_LISTS = [
  '/api/v1/orders',
  '/api/v1/pos/transactions',
  '/api/v1/returns',
  '/api/v1/exchanges',
  '/api/v1/payments/unpaid-orders',
  '/api/v1/payments',
  '/api/v1/purchase-orders',
  '/api/v1/financial-transactions',
  '/api/v1/receivables',
  '/api/v1/receivables/summary',
  '/api/v1/inventory',
  '/api/v1/reports/sales',
  '/api/v1/reports/kpis',
];

function withBranch(path: string, branchId: number): string {
  return `${path}${path.includes('?') ? '&' : '?'}branchId=${branchId}`;
}

describe('Branch scope', () => {
  const api = () => request(getTestApp());
  let branchA: number;
  let branchB: number;
  let orderA: number;
  let orderB: number;
  let adminA: string; // Admin in branch A only
  let globalAdmin: string; // access to all branches, signed in to branch A

  async function insertOrder(branchId: number, staffId: number, label: string): Promise<number> {
    const loc = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, true) RETURNING id`,
      [branchId, `${BRANCH_PREFIX} Loc ${label}`],
    );
    const order = await db.query(
      `INSERT INTO orders (order_number, branch_id, location_id, created_by, status)
       VALUES ($1, $2, $3, $4, 'COMPLETED') RETURNING id`,
      [`SCOPE-${label}-${Date.now()}`, branchId, loc.rows[0].id, staffId],
    );
    return order.rows[0].id as number;
  }

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX} A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX} B` })).branchId;

    const a = await createTestStaff({ username: `${STAFF_PREFIX}admin_a`, role: 'Admin', branchId: branchA });
    adminA = a.token;

    const g = await createTestStaff({ username: `${STAFF_PREFIX}global`, role: 'Admin', branchId: branchA });
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [g.staffId]);
    globalAdmin = g.token;

    orderA = await insertOrder(branchA, a.staffId, 'A');
    orderB = await insertOrder(branchB, a.staffId, 'B');
  });

  afterAll(async () => {
    await db.query(`DELETE FROM orders WHERE id = ANY($1)`, [[orderA, orderB]]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  describe('staff with roles in one branch', () => {
    it('GET /orders without branchId lists only the session branch (was: every branch)', async () => {
      const res = await api().get('/api/v1/orders?pageSize=100').set('Authorization', `Bearer ${adminA}`);
      expect(res.status).toBe(200);
      const ids = res.body.items.map((o: { id: number }) => o.id);
      expect(ids).toContain(orderA);
      expect(ids).not.toContain(orderB);
    });

    it.each(SCOPED_LISTS)('%s refuses another branch with 403 BRANCH_ACCESS_DENIED', async (path) => {
      const res = await api().get(withBranch(path, branchB)).set('Authorization', `Bearer ${adminA}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'BRANCH_ACCESS_DENIED', details: { branchId: branchB } });
    });

    it.each(SCOPED_LISTS)('%s accepts the session branch', async (path) => {
      const res = await api().get(withBranch(path, branchA)).set('Authorization', `Bearer ${adminA}`);
      expect(res.status).toBe(200);
    });

    it('treats an empty or "null" branchId as no branch, as the web app sends it', async () => {
      for (const value of ['', 'null', '0']) {
        const res = await api().get(`/api/v1/orders?branchId=${value}`).set('Authorization', `Bearer ${adminA}`);
        expect(res.status).toBe(200);
      }
    });
  });

  describe('staff with different roles in two branches', () => {
    let tokenInA: string;
    let staffId: number;

    beforeAll(async () => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}multi`, role: 'Sales', branchId: branchA });
      staffId = s.staffId;
      await db.query(`INSERT INTO staff_branch_roles (staff_id, branch_id, role) VALUES ($1, $2, 'Manager')`, [staffId, branchB]);
      tokenInA = jwt.sign(
        { staffId, role: 'Sales', roles: ['Sales'], branchId: branchA, permissions: ['CREATE_SALE', 'PROCESS_PAYMENT'] },
        process.env.JWT_SECRET!,
        { expiresIn: '15m' },
      );
    });

    it('cannot read branch B while signed in to branch A, even with a role in B', async () => {
      const res = await api().get(withBranch('/api/v1/orders', branchB)).set('Authorization', `Bearer ${tokenInA}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('BRANCH_ACCESS_DENIED');
    });

    it('works in branch B with B\'s roles after switching branch', async () => {
      // Sales in A has no report access.
      const before = await api().get('/api/v1/reports/sales').set('Authorization', `Bearer ${tokenInA}`);
      expect(before.status).toBe(403);

      const switched = await api()
        .post('/api/v1/auth/switch-branch')
        .set('Authorization', `Bearer ${tokenInA}`)
        .send({ branchId: branchB });
      expect(switched.status).toBe(200);
      const tokenInB = switched.body.accessToken as string;

      // Manager in B does.
      const report = await api().get('/api/v1/reports/sales').set('Authorization', `Bearer ${tokenInB}`);
      expect(report.status).toBe(200);

      const orders = await api().get('/api/v1/orders?pageSize=100').set('Authorization', `Bearer ${tokenInB}`);
      const ids = orders.body.items.map((o: { id: number }) => o.id);
      expect(ids).toContain(orderB);
      expect(ids).not.toContain(orderA);
    });

    it('loses access at once when the role in the session branch is removed', async () => {
      await db.query(`DELETE FROM staff_branch_roles WHERE staff_id = $1 AND branch_id = $2`, [staffId, branchA]);

      const res = await api().get('/api/v1/orders').set('Authorization', `Bearer ${tokenInA}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'BRANCH_ACCESS_DENIED', details: { branchId: branchA } });
    });
  });

  describe('staff with access to all branches', () => {
    it('may read another branch by naming it', async () => {
      const res = await api()
        .get(withBranch('/api/v1/orders?pageSize=100', branchB))
        .set('Authorization', `Bearer ${globalAdmin}`);
      expect(res.status).toBe(200);
      const ids = res.body.items.map((o: { id: number }) => o.id);
      expect(ids).toContain(orderB);
      expect(ids).not.toContain(orderA);
    });

    it('gets the session branch on lists when naming no branch', async () => {
      const res = await api().get('/api/v1/orders?pageSize=100').set('Authorization', `Bearer ${globalAdmin}`);
      const ids = res.body.items.map((o: { id: number }) => o.id);
      expect(ids).toContain(orderA);
      expect(ids).not.toContain(orderB);
    });

    it('gets every branch on reports when naming no branch (the dashboard\'s "All")', async () => {
      const all = await api().get('/api/v1/reports/sales').set('Authorization', `Bearer ${globalAdmin}`);
      const own = await api().get(withBranch('/api/v1/reports/sales', branchA)).set('Authorization', `Bearer ${globalAdmin}`);
      expect(all.status).toBe(200);
      const branchIds = (r: request.Response) => (r.body.byBranch as { branchId: number }[]).map((b) => b.branchId);
      expect(branchIds(own).every((id) => id === branchA)).toBe(true);
      expect(branchIds(all).length).toBeGreaterThanOrEqual(branchIds(own).length);
    });
  });
});
