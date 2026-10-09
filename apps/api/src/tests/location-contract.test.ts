import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { LocationListResponseSchema, LocationSchema, StaffLocationListResponseSchema } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Behaviour the Locations migration (#21) adds on top of location.test.ts and
// locationAccess.test.ts: responses follow the shared contracts, and a
// branch's locations and its staff's restrictions change only from that branch.

const STAFF_PREFIX = 'locc_test_';
const BRANCH_PREFIX = 'Loc Contract ';

describe('Locations on the shared contracts', () => {
  let branchA: number;
  let branchB: number;
  let locA: number;
  let locB: number;
  let managerOfA: string;
  let allBranchesAdmin: string;
  let multiBranchStaff: number;
  let onlyBStaff: number;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);
  const locationOf = async (id: number) => (await db.query(`SELECT name, is_default_fulfillment FROM locations WHERE id = $1`, [id])).rows[0];
  const assigned = async (staffId: number) =>
    (await db.query(`SELECT location_id FROM staff_locations WHERE staff_id = $1 ORDER BY location_id`, [staffId])).rows.map((r) => r.location_id);

  async function cleanUp() {
    await db.query(`DELETE FROM staff_locations WHERE staff_id IN (SELECT id FROM staff WHERE username LIKE $1)`, [`${STAFF_PREFIX}%`]);
    await db.query(`DELETE FROM audit_logs WHERE staff_id IN (SELECT id FROM staff WHERE username LIKE $1)`, [`${STAFF_PREFIX}%`]);
    await db.query(`DELETE FROM locations WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE $1)`, [`${BRANCH_PREFIX}%`]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    locA = (await db.query(`INSERT INTO locations (branch_id, name) VALUES ($1, 'Loc Contract Floor A') RETURNING id`, [branchA])).rows[0].id;
    locB = (await db.query(`INSERT INTO locations (branch_id, name) VALUES ($1, 'Loc Contract Floor B') RETURNING id`, [branchB])).rows[0].id;

    managerOfA = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId: branchA })).token;
    const all = await createTestStaff({ username: `${STAFF_PREFIX}all`, role: 'Admin', branchId: branchA });
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [all.staffId]);
    allBranchesAdmin = all.token;

    multiBranchStaff = (await createTestStaff({ username: `${STAFF_PREFIX}multi`, role: 'Sales', branchId: branchA })).staffId;
    await db.query(`INSERT INTO staff_branch_roles (staff_id, branch_id, role) VALUES ($1, $2, 'Sales')`, [multiBranchStaff, branchB]);
    onlyBStaff = (await createTestStaff({ username: `${STAFF_PREFIX}onlyb`, role: 'Sales', branchId: branchB })).staffId;
  });

  afterAll(cleanUp);

  it('answers in the shape of the shared schemas', async () => {
    const list = await as(api().get(`/api/v1/branches/${branchA}/locations?pageSize=50`), managerOfA);
    expect(list.status).toBe(200);
    expect(LocationListResponseSchema.strict().parse(list.body)).toEqual(list.body);

    const created = await as(api().post(`/api/v1/branches/${branchA}/locations`), managerOfA).send({ name: 'Loc Contract Shelf' });
    expect(created.status).toBe(201);
    expect(LocationSchema.strict().parse(created.body)).toEqual(created.body);

    const staff = await as(api().get(`/api/v1/staff/${multiBranchStaff}/locations`), managerOfA);
    expect(StaffLocationListResponseSchema.strict().parse(staff.body)).toEqual(staff.body);
  });

  it('answers 400 VALIDATION_ERROR for an id that is not a number', async () => {
    const res = await as(api().put(`/api/v1/branches/${branchA}/locations/abc`), managerOfA).send({ name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('does not rename, default or delete another branch\'s location through the session branch\'s URL (was: 200)', async () => {
    const url = `/api/v1/branches/${branchA}/locations/${locB}`;
    for (const res of [
      await as(api().put(url), managerOfA).send({ name: 'Renamed from A' }),
      await as(api().put(`${url}/set-default`), managerOfA),
      await as(api().delete(url), managerOfA),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(await locationOf(locB)).toEqual({ name: 'Loc Contract Floor B', is_default_fulfillment: false });
  });

  it('keeps another branch\'s restrictions when a manager saves their own branch\'s (was: deleted)', async () => {
    await db.query(`INSERT INTO staff_locations (staff_id, location_id) VALUES ($1, $2)`, [multiBranchStaff, locB]);

    // The staff page sends every branch's locations, the other branch's unchanged.
    const res = await as(api().put(`/api/v1/staff/${multiBranchStaff}/locations`), managerOfA).send([locA, locB]);

    expect(res.status).toBe(200);
    expect(await assigned(multiBranchStaff)).toEqual([locA, locB].sort((x, y) => x - y));
  });

  it('refuses to change another branch\'s restrictions, and keeps them', async () => {
    const res = await as(api().put(`/api/v1/staff/${multiBranchStaff}/locations`), managerOfA).send([]);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('BRANCH_ACCESS_DENIED');
    expect(await assigned(multiBranchStaff)).toEqual([locA, locB].sort((x, y) => x - y));
  });

  it('refuses to read or set restrictions of staff who work only in another branch (was: 200)', async () => {
    const read = await as(api().get(`/api/v1/staff/${onlyBStaff}/locations`), managerOfA);
    const write = await as(api().put(`/api/v1/staff/${onlyBStaff}/locations`), managerOfA).send([locB]);

    for (const res of [read, write]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('BRANCH_ACCESS_DENIED');
    }
    expect(await assigned(onlyBStaff)).toEqual([]);
  });

  it('lets staff with access to all branches change any branch\'s restrictions', async () => {
    expect((await as(api().put(`/api/v1/staff/${onlyBStaff}/locations`), allBranchesAdmin).send([locB])).status).toBe(200);
    expect((await as(api().put(`/api/v1/staff/${multiBranchStaff}/locations`), allBranchesAdmin).send([])).status).toBe(200);
    expect(await assigned(onlyBStaff)).toEqual([locB]);
    expect(await assigned(multiBranchStaff)).toEqual([]);
  });
});
