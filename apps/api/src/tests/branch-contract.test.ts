import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { BranchListResponseSchema, BranchSchema, PublicBranchListResponseSchema } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Behaviour the Branches migration (#21) adds on top of branch.test.ts:
// responses follow the shared contracts; opening, closing and deleting a
// branch are head-office actions; details are edited from the branch itself.

const STAFF_PREFIX = 'brc_test_';
const BRANCH_PREFIX = 'Branch Contract ';

describe('Branches on the shared contracts', () => {
  let branchA: number;
  let branchB: number;
  let managerOfA: string;
  let adminOfA: string;
  let headOffice: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);
  const branchRow = async (id: number) =>
    (await db.query(`SELECT name, address, contact_info, operating_hours, is_active FROM branches WHERE id = $1`, [id])).rows[0];

  async function cleanUp() {
    await db.query(`DELETE FROM locations WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE $1)`, [`${BRANCH_PREFIX}%`]);
    await db.query(`DELETE FROM audit_logs WHERE entity_type = 'branch' AND entity_id IN (SELECT id::text FROM branches WHERE name LIKE $1)`, [`${BRANCH_PREFIX}%`]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    await db.query(
      `UPDATE branches SET contact_info = '{"phone":"0911","email":"b@shop.et"}', operating_hours = '{"mon":"08:00-20:00"}' WHERE id = $1`,
      [branchB],
    );
    managerOfA = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId: branchA })).token;
    adminOfA = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId: branchA })).token;
    const ho = await createTestStaff({ username: `${STAFF_PREFIX}ho`, role: 'Admin', branchId: branchA });
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [ho.staffId]);
    headOffice = ho.token;
  });

  afterAll(cleanUp);

  it('answers in the shape of the shared schemas', async () => {
    const pub = await api().get('/api/v1/branches/public');
    expect(PublicBranchListResponseSchema.strict().parse(pub.body)).toEqual(pub.body);

    const list = await as(api().get(`/api/v1/branches?isActive=true&pageSize=100`), managerOfA);
    expect(BranchListResponseSchema.strict().parse(list.body)).toEqual(list.body);

    const one = await as(api().get(`/api/v1/branches/${branchA}`), managerOfA);
    expect(BranchSchema.strict().parse(one.body)).toEqual(one.body);
  });

  it('answers 400 VALIDATION_ERROR for an id that is not a number (was: 500)', async () => {
    const res = await as(api().get('/api/v1/branches/abc'), managerOfA);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('refuses to edit, close or reopen another branch from a branch-limited session (was: 200)', async () => {
    const edit = await as(api().put(`/api/v1/branches/${branchB}`), managerOfA).send({ address: 'changed from A' });
    expect(edit.status).toBe(403);
    expect(edit.body.error).toBe('BRANCH_ACCESS_DENIED');

    for (const action of ['deactivate', 'reactivate']) {
      for (const token of [managerOfA, adminOfA]) {
        const res = await as(api().post(`/api/v1/branches/${branchB}/${action}`), token);
        expect(res.status).toBe(403);
      }
    }
    expect(await branchRow(branchB)).toMatchObject({ address: '123 Test Street', is_active: true });
  });

  it('lets only head office open a branch (was: Managers too)', async () => {
    const byManager = await as(api().post('/api/v1/branches'), managerOfA).send({ name: `${BRANCH_PREFIX}By Manager`, address: 'x' });
    expect(byManager.status).toBe(403);

    const byHeadOffice = await as(api().post('/api/v1/branches'), headOffice).send({ name: `${BRANCH_PREFIX}C`, address: 'x' });
    expect(byHeadOffice.status).toBe(201);
    expect(BranchSchema.strict().parse(byHeadOffice.body)).toEqual(byHeadOffice.body);
  });

  it('lets a Manager edit their own branch, changing only the fields sent (was: unsent details reset to defaults)', async () => {
    const res = await as(api().put(`/api/v1/branches/${branchB}`), headOffice).send({ address: '2 New Rd' });

    expect(res.status).toBe(200);
    expect(await branchRow(branchB)).toMatchObject({
      address: '2 New Rd',
      contact_info: { phone: '0911', email: 'b@shop.et' },
      operating_hours: { mon: '08:00-20:00' },
    });
    expect((await as(api().put(`/api/v1/branches/${branchA}`), managerOfA).send({ address: '3 Own St' })).status).toBe(200);
  });

  it('answers 409 for a rename to a name already taken (was: 500)', async () => {
    const res = await as(api().put(`/api/v1/branches/${branchB}`), headOffice).send({ name: `${BRANCH_PREFIX}A` });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_BRANCH_NAME');
  });

  it('answers 409 listing what blocks the delete of a branch with locations (was: 500)', async () => {
    await db.query(`INSERT INTO locations (branch_id, name) VALUES ($1, 'Branch Contract Floor')`, [branchB]);

    const res = await as(api().delete(`/api/v1/branches/${branchB}`), headOffice);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'DEPENDENCY_CONFLICT',
      details: { blockingDependencies: [{ type: 'locations', count: 1 }] },
    });
  });
});
