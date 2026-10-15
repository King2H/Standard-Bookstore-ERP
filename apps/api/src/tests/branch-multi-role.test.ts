import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

// #23: opening, closing and deleting a branch need Super_Admin, or Admin with
// access to all branches. The rule looked only at the first role held in the
// session branch (in the order the roles were given), so a Manager later made
// Admin there was refused although Admin is among the roles they hold.

const STAFF_PREFIX = 'branch_multi_test_';
const BRANCH_PREFIX = 'Branch Multi Test ';

describe('Branch open and close for staff with several roles', () => {
  let promotedToken: string;
  let managerToken: string;
  let homeBranch: number;
  let otherBranch: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    homeBranch = (await createTestBranch({ name: `${BRANCH_PREFIX}Home` })).branchId;
    otherBranch = (await createTestBranch({ name: `${BRANCH_PREFIX}Other` })).branchId;

    // A Manager first, made Admin of the same branch later.
    const promoted = await createTestStaff({ username: `${STAFF_PREFIX}promoted`, role: 'Manager', branchId: homeBranch });
    await db.query(`INSERT INTO staff_branch_roles (staff_id, branch_id, role) VALUES ($1, $2, 'Admin')`, [promoted.staffId, homeBranch]);
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [promoted.staffId]);
    promotedToken = promoted.token;

    const manager = await createTestStaff({ username: `${STAFF_PREFIX}manager`, role: 'Manager', branchId: homeBranch });
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [manager.staffId]);
    managerToken = manager.token;
  });

  afterAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  it('lets an Admin with access to all branches close and reopen a branch, whatever role they were given first (was: 403)', async () => {
    const closed = await request(getTestApp()).post(`/api/v1/branches/${otherBranch}/deactivate`).set('Authorization', `Bearer ${promotedToken}`);
    expect(closed.status).toBe(200);
    const opened = await request(getTestApp()).post(`/api/v1/branches/${otherBranch}/reactivate`).set('Authorization', `Bearer ${promotedToken}`);
    expect(opened.status).toBe(200);
  });

  it('still refuses a Manager, even with access to all branches', async () => {
    const res = await request(getTestApp()).post(`/api/v1/branches/${otherBranch}/deactivate`).set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(403);
  });
});
