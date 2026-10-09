import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanBranchConfig, cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #77: /config/branches/:branchId took the branch from the URL without
// checking it against the session, so a Manager of one branch could read and
// change another branch's settings.

const STAFF_PREFIX = 'cfgscope_test_';
const BRANCH_PREFIX = 'Config Scope ';

describe('Branch settings are limited to the session branch', () => {
  let branchA: number;
  let branchB: number;
  let managerOfA: string;
  let adminOfA: string;
  let allBranchesAdmin: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  const overrideOnB = async () =>
    (await db.query(`SELECT value FROM branch_config WHERE branch_id = $1 AND key = 'return_window_days'`, [branchB])).rows;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    managerOfA = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId: branchA })).token;
    adminOfA = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId: branchA })).token;
    const all = await createTestStaff({ username: `${STAFF_PREFIX}all`, role: 'Admin', branchId: branchA });
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [all.staffId]);
    allBranchesAdmin = all.token;
  });

  afterAll(async () => {
    await cleanBranchConfig(branchA);
    await cleanBranchConfig(branchB);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  it('refuses to read another branch\'s settings (was: 200)', async () => {
    const res = await as(api().get(`/api/v1/config/branches/${branchB}`), managerOfA);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('BRANCH_ACCESS_DENIED');
  });

  it('refuses to override another branch\'s setting, and saves nothing (was: 200, saved)', async () => {
    const res = await as(api().put(`/api/v1/config/branches/${branchB}/return_window_days`), managerOfA).send({ value: 99 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('BRANCH_ACCESS_DENIED');
    expect(await overrideOnB()).toEqual([]);
  });

  it('refuses to remove another branch\'s override, and keeps it', async () => {
    expect((await as(api().put(`/api/v1/config/branches/${branchB}/return_window_days`), allBranchesAdmin).send({ value: 21 })).status).toBe(200);

    const res = await as(api().delete(`/api/v1/config/branches/${branchB}/return_window_days`), adminOfA);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('BRANCH_ACCESS_DENIED');
    expect(await overrideOnB()).toEqual([{ value: 21 }]);
  });

  it('still allows the session branch, and any branch with access to all branches', async () => {
    expect((await as(api().put(`/api/v1/config/branches/${branchA}/return_window_days`), managerOfA).send({ value: 10 })).status).toBe(200);
    expect((await as(api().get(`/api/v1/config/branches/${branchA}`), managerOfA)).status).toBe(200);
    expect((await as(api().get(`/api/v1/config/branches/${branchB}`), allBranchesAdmin)).status).toBe(200);
    expect((await as(api().delete(`/api/v1/config/branches/${branchB}/return_window_days`), allBranchesAdmin)).status).toBe(200);
  });
});
