/**
 * staff-administration.test.ts
 *
 * Staff administration (#21, auth part 2), owner decisions 1a–5a:
 * - 1a: Super_Admin administers everyone; an Admin with access to all
 *   branches everyone below them; another Admin the staff whose roles are all
 *   in their Admin branches; a Manager the roles in their session branch;
 * - 2a: only people ranked strictly below you, never yourself, granting only
 *   roles below your own (a Super_Admin grants any);
 * - 3a: only a Super_Admin grants or removes access to all branches;
 * - 4a: usernames are unique ignoring case, and signing in ignores case;
 * - 5a: an account is created with its roles in one step.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'staff_adm_test_';
const BRANCH_PREFIX = 'Staff Admin Test ';
const NEW_PASSWORD = 'Temp#2026pass';

const api = () => request(getTestApp());
type Staff = Awaited<ReturnType<typeof createTestStaff>>;

async function rolesOf(staffId: number): Promise<string[]> {
  const { rows } = await db.query(`SELECT branch_id, role FROM staff_branch_roles WHERE staff_id = $1 ORDER BY branch_id, role`, [staffId]);
  return rows.map((r) => `${r.branch_id}:${r.role}`);
}

async function addRole(staffId: number, branchId: number, role: string) {
  await db.query(`INSERT INTO staff_branch_roles (staff_id, branch_id, role) VALUES ($1, $2, $3)`, [staffId, branchId, role]);
}

describe('Staff administration', () => {
  let branchA: number;
  let branchB: number;
  let superAdmin: Staff;
  let adminA: Staff;
  let adminAll: Staff;
  let managerA: Staff;
  let salesA: Staff;
  let salesB: Staff;

  const as = (who: Staff) => ({
    get: (path: string) => api().get(path).set('Authorization', `Bearer ${who.token}`),
    post: (path: string, body: object = {}) => api().post(path).set('Authorization', `Bearer ${who.token}`).send(body),
    put: (path: string, body: object) => api().put(path).set('Authorization', `Bearer ${who.token}`).send(body),
  });
  const staff = (name: string, role: Parameters<typeof createTestStaff>[0]['role'], branchId: number) =>
    createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId });

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    superAdmin = await staff('super', 'Super_Admin', branchA);
    adminA = await staff('admina', 'Admin', branchA);
    adminAll = await staff('adminall', 'Admin', branchA);
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [adminAll.staffId]);
    managerA = await staff('mgra', 'Manager', branchA);
    salesA = await staff('salesa', 'Sales', branchA);
    salesB = await staff('salesb', 'Sales', branchB);
  });

  afterAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await db.query(`DELETE FROM staff WHERE lower(username) LIKE $1`, [`${STAFF_PREFIX}%`]);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  describe('nobody raises their own or an equal rank (owner decision 2a)', () => {
    it('a Manager cannot make themselves or anyone else Admin (was: 200)', async () => {
      const self = await as(managerA).put(`/api/v1/staff/${managerA.staffId}/roles`, [{ branchId: branchA, role: 'Admin' }]);
      expect(self.status).toBe(422);
      expect(self.body.error).toBe('CANNOT_MANAGE_SELF');

      const other = await as(managerA).put(`/api/v1/staff/${salesA.staffId}/roles`, [{ branchId: branchA, role: 'Admin' }]);
      expect(other.status).toBe(403);
      expect(await rolesOf(managerA.staffId)).toEqual([`${branchA}:Manager`]);
      expect(await rolesOf(salesA.staffId)).toEqual([`${branchA}:Sales`]);
    });

    it('an Admin cannot make themselves Super_Admin or take over a Super_Admin (was: 200, 200)', async () => {
      const self = await as(adminA).put(`/api/v1/staff/${adminA.staffId}/roles`, [{ branchId: branchA, role: 'Super_Admin' }]);
      expect(self.status).toBe(422);
      const reset = await as(adminA).post(`/api/v1/staff/${superAdmin.staffId}/reset-password`, { temporaryPassword: NEW_PASSWORD });
      expect(reset.status).toBe(403);
      expect((await db.query(`SELECT must_change_password FROM staff WHERE id = $1`, [superAdmin.staffId])).rows[0].must_change_password).toBe(false);
    });

    it('a Manager cannot change an Admin, and an Admin cannot change another Admin (was: demoted to Sales)', async () => {
      const otherAdmin = await staff('admina2', 'Admin', branchA);
      expect((await as(managerA).put(`/api/v1/staff/${otherAdmin.staffId}/roles`, [{ branchId: branchA, role: 'Sales' }])).status).toBe(403);
      expect((await as(adminA).put(`/api/v1/staff/${otherAdmin.staffId}/roles`, [{ branchId: branchA, role: 'Sales' }])).status).toBe(403);
      expect(await rolesOf(otherAdmin.staffId)).toEqual([`${branchA}:Admin`]);
    });

    it('an Admin grants Manager and below, a Super_Admin grants Admin', async () => {
      const s = await staff('promote', 'Sales', branchA);
      expect((await as(adminA).put(`/api/v1/staff/${s.staffId}/roles`, [{ branchId: branchA, role: 'Admin' }])).status).toBe(403);
      expect((await as(adminA).put(`/api/v1/staff/${s.staffId}/roles`, [{ branchId: branchA, role: 'Manager' }])).status).toBe(200);
      expect((await as(superAdmin).put(`/api/v1/staff/${s.staffId}/roles`, [{ branchId: branchA, role: 'Admin' }])).status).toBe(200);
      expect(await rolesOf(s.staffId)).toEqual([`${branchA}:Admin`]);
    });

    it('the last Super_Admin cannot take the role away from themselves (was: 200)', async () => {
      const res = await as(superAdmin).put(`/api/v1/staff/${superAdmin.staffId}/roles`, [{ branchId: branchA, role: 'Sales' }]);
      expect(res.status).toBe(422);
      expect(await rolesOf(superAdmin.staffId)).toEqual([`${branchA}:Super_Admin`]);
    });
  });

  describe('each administrator works on their own branches (owner decision 1a)', () => {
    it('keeps the roles in branches the editor does not manage (was: all replaced)', async () => {
      const s = await staff('twobr', 'Sales', branchA);
      await addRole(s.staffId, branchB, 'Stock_Clerk');

      // Dropping branch B is not the Manager's to do.
      const dropped = await as(managerA).put(`/api/v1/staff/${s.staffId}/roles`, [{ branchId: branchA, role: 'Stock_Clerk' }]);
      expect(dropped.status).toBe(403);
      expect(await rolesOf(s.staffId)).toEqual([`${branchA}:Sales`, `${branchB}:Stock_Clerk`]);

      const changed = await as(managerA).put(`/api/v1/staff/${s.staffId}/roles`, [
        { branchId: branchA, role: 'Stock_Clerk' },
        { branchId: branchB, role: 'Stock_Clerk' },
      ]);
      expect(changed.status).toBe(200);
      expect(await rolesOf(s.staffId)).toEqual([`${branchA}:Stock_Clerk`, `${branchB}:Stock_Clerk`]);
    });

    it('an Admin of branch A cannot see or change staff who work only in branch B (was: reset and deactivated)', async () => {
      expect((await as(adminA).get(`/api/v1/staff/${salesB.staffId}`)).status).toBe(404);
      expect((await as(adminA).post(`/api/v1/staff/${salesB.staffId}/reset-password`, { temporaryPassword: NEW_PASSWORD })).status).toBe(404);
      expect((await as(adminA).post(`/api/v1/staff/${salesB.staffId}/deactivate`)).status).toBe(404);
      expect((await db.query(`SELECT is_active FROM staff WHERE id = $1`, [salesB.staffId])).rows[0].is_active).toBe(true);
    });

    it('an Admin with access to all branches manages staff in every branch', async () => {
      expect((await as(adminAll).post(`/api/v1/staff/${salesB.staffId}/unlock`)).status).toBe(200);
    });

    it('a Manager reads only the staff of their branch (was: any branch)', async () => {
      expect((await as(managerA).get(`/api/v1/staff/${salesB.staffId}`)).status).toBe(404);
      expect((await as(managerA).get(`/api/v1/staff/${salesA.staffId}`)).status).toBe(200);
    });

    it('a Manager cannot create, deactivate, reset or unlock', async () => {
      expect((await as(managerA).post('/api/v1/staff', { username: `${STAFF_PREFIX}bymgr`, password: NEW_PASSWORD, fullName: 'X' })).status).toBe(403);
      expect((await as(managerA).post(`/api/v1/staff/${salesA.staffId}/deactivate`)).status).toBe(403);
      expect((await as(managerA).post(`/api/v1/staff/${salesA.staffId}/reset-password`, { temporaryPassword: NEW_PASSWORD })).status).toBe(403);
      expect((await as(managerA).post(`/api/v1/staff/${salesA.staffId}/unlock`)).status).toBe(403);
    });
  });

  describe('listing', () => {
    it("lists a Manager's branch staff, marking which they may change (was: 500)", async () => {
      const res = await as(managerA).get('/api/v1/staff?pageSize=100');
      expect(res.status).toBe(200);
      const byName = new Map<string, { canManage: boolean }>(res.body.items.map((s: { username: string; canManage: boolean }) => [s.username, s]));
      expect(byName.has(`${STAFF_PREFIX}salesb`)).toBe(false);
      expect(byName.get(`${STAFF_PREFIX}salesa`)?.canManage).toBe(true);
      expect(byName.get(`${STAFF_PREFIX}admina`)?.canManage).toBe(false);
      expect(byName.get(`${STAFF_PREFIX}mgra`)?.canManage).toBe(false);
    });

    it('validates the page size (was: 500 for text, any size accepted)', async () => {
      expect((await as(adminAll).get('/api/v1/staff?pageSize=abc')).status).toBe(400);
      const big = await as(adminAll).get('/api/v1/staff?pageSize=100000');
      expect(big.status).toBe(200);
      expect(big.body.pageSize).toBe(100);
    });
  });

  describe('all-branch access (owner decision 3a)', () => {
    it('an Admin cannot give it, to themselves or anyone (was: 200)', async () => {
      expect((await as(adminAll).put(`/api/v1/staff/${adminAll.staffId}/all-branches`, { isAllBranches: true })).status).toBe(403);
      expect((await as(adminA).put(`/api/v1/staff/${adminA.staffId}/all-branches`, { isAllBranches: true })).status).toBe(403);
      expect((await db.query(`SELECT is_all_branches FROM staff WHERE id = $1`, [adminA.staffId])).rows[0].is_all_branches).toBe(false);
    });

    it('a Super_Admin gives and takes it', async () => {
      const s = await staff('allbr', 'Sales', branchA);
      expect((await as(superAdmin).put(`/api/v1/staff/${s.staffId}/all-branches`, { isAllBranches: true })).status).toBe(200);
      expect((await db.query(`SELECT is_all_branches FROM staff WHERE id = $1`, [s.staffId])).rows[0].is_all_branches).toBe(true);
    });
  });

  describe('creating staff (owner decisions 4a, 5a)', () => {
    it('creates the account with its roles in one step, audited with the actor (was: SYSTEM)', async () => {
      const res = await as(adminA).post('/api/v1/staff', {
        username: `${STAFF_PREFIX}new1`,
        password: NEW_PASSWORD,
        fullName: 'New One',
        roles: [{ branchId: branchA, role: 'Sales' }],
      });
      expect(res.status).toBe(201);
      expect(await rolesOf(res.body.staffId)).toEqual([`${branchA}:Sales`]);
      const { rows } = await db.query(`SELECT staff_id, staff_role FROM audit_logs WHERE entity_type = 'staff' AND entity_id = $1 AND action = 'CREATE'`, [
        String(res.body.staffId),
      ]);
      expect(rows).toEqual([{ staff_id: adminA.staffId, staff_role: 'Admin' }]);
    });

    it('creates nothing when a role or all-branch access is not the creator\'s to give', async () => {
      for (const body of [
        { roles: [{ branchId: branchA, role: 'Admin' }] },
        { roles: [{ branchId: branchB, role: 'Sales' }] },
        { roles: [{ branchId: branchA, role: 'Sales' }], isAllBranches: true },
      ]) {
        const res = await as(adminA).post('/api/v1/staff', { username: `${STAFF_PREFIX}nope`, password: NEW_PASSWORD, fullName: 'Nope', ...body });
        expect(res.status, JSON.stringify(body)).toBe(403);
      }
      expect((await db.query(`SELECT 1 FROM staff WHERE username = $1`, [`${STAFF_PREFIX}nope`])).rows).toHaveLength(0);
    });

    it('refuses a username that differs only in letter case, and signs in ignoring case (was: two accounts)', async () => {
      const res = await as(adminA).post('/api/v1/staff', {
        username: `${STAFF_PREFIX}SALESA`.toUpperCase(),
        password: NEW_PASSWORD,
        fullName: 'Shadow',
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('DUPLICATE_USERNAME');

      const login = await api().post('/api/v1/auth/login').send({ username: `${STAFF_PREFIX}SalesA`, password: 'Test@12345', branchId: branchA });
      expect(login.status).toBe(200);
    });

    it('refuses usernames with spaces or other characters', async () => {
      const res = await as(adminA).post('/api/v1/staff', { username: 'two words', password: NEW_PASSWORD, fullName: 'X' });
      expect(res.status).toBe(400);
    });
  });

  describe('audit and unknown accounts', () => {
    it('audits role changes, deactivation and reactivation with the actor (was: SYSTEM, nothing)', async () => {
      const s = await staff('audited', 'Sales', branchA);
      await as(adminA).put(`/api/v1/staff/${s.staffId}/roles`, [{ branchId: branchA, role: 'Stock_Clerk' }]);
      await as(adminA).post(`/api/v1/staff/${s.staffId}/deactivate`);
      await as(adminA).post(`/api/v1/staff/${s.staffId}/reactivate`);
      const { rows } = await db.query(
        `SELECT action, entity_type, staff_id FROM audit_logs WHERE entity_type IN ('staff', 'staff_roles') AND entity_id = $1 ORDER BY id`,
        [String(s.staffId)],
      );
      expect(rows).toEqual([
        { action: 'UPDATE', entity_type: 'staff_roles', staff_id: adminA.staffId },
        { action: 'INACTIVATE', entity_type: 'staff', staff_id: adminA.staffId },
        { action: 'ACTIVATE', entity_type: 'staff', staff_id: adminA.staffId },
      ]);
    });

    it('answers 404 for an account that does not exist (was: 200, or 500 for roles)', async () => {
      const id = 2_000_000_000;
      expect((await as(superAdmin).put(`/api/v1/staff/${id}`, { fullName: 'X' })).status).toBe(404);
      expect((await as(superAdmin).post(`/api/v1/staff/${id}/deactivate`)).status).toBe(404);
      expect((await as(superAdmin).put(`/api/v1/staff/${id}/roles`, [{ branchId: branchA, role: 'Sales' }])).status).toBe(404);
      expect((await as(superAdmin).put(`/api/v1/staff/${id}/all-branches`, { isAllBranches: true })).status).toBe(404);
    });
  });
});
