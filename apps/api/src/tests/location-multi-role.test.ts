import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #23 (Staff screen): Managers are never limited to their assigned locations
// (#72). The rule looked only at the first role held in the session branch, in
// the order the roles were given, so a Stock_Clerk limited to one location and
// later made Manager of the same branch stayed limited.

const STAFF_PREFIX = 'locmr_test_';
const BRANCH_PREFIX = 'Loc Multi Role ';

describe('Location limits for staff with several roles', () => {
  let branchId: number;
  let locA: number;
  let locB: number;
  let bookId: number;
  let promoted: string;
  let clerk: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  async function cleanUp() {
    const branches = (await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`])).rows.map((r) => r.id);
    if (branches.length) {
      const locs = `(SELECT id FROM locations WHERE branch_id = ANY($1))`;
      await db.query(`DELETE FROM inventory_history WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM inventory WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM staff_locations WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM locations WHERE branch_id = ANY($1)`, [branches]);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
    locA = (await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Loc Multi A', true) RETURNING id`, [branchId])).rows[0].id;
    locB = (await db.query(`INSERT INTO locations (branch_id, name) VALUES ($1, 'Loc Multi B') RETURNING id`, [branchId])).rows[0].id;
    bookId = (await db.query(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 1`)).rows[0].id;
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 20, 0, 0)`, [bookId, locB]);

    const limitedClerk = async (username: string) => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}${username}`, role: 'Stock_Clerk', branchId });
      await db.query(`INSERT INTO staff_locations (staff_id, location_id) VALUES ($1, $2)`, [s.staffId, locA]);
      return s;
    };
    // A Stock_Clerk first, made Manager of the same branch later.
    const p = await limitedClerk('promoted');
    await db.query(`INSERT INTO staff_branch_roles (staff_id, branch_id, role) VALUES ($1, $2, 'Manager')`, [p.staffId, branchId]);
    promoted = p.token;
    clerk = (await limitedClerk('clerk')).token;
  });

  afterAll(cleanUp);

  it('lets a Stock_Clerk later made Manager book stock at any location of the branch (was: 403)', async () => {
    const res = await as(api().post('/api/v1/inventory/stock-in'), promoted).send({ bookId, locationId: locB, quantity: 1, version: 0, unitCost: 10 });
    expect(res.status).toBe(200);
  });

  it('shows them every location of the branch (was: only the assigned one)', async () => {
    const res = await as(api().get(`/api/v1/branches/${branchId}/locations`), promoted);
    expect(res.status).toBe(200);
    expect(res.body.accessMode).toBe('full');
    expect(res.body.items.map((l: { id: number }) => l.id).sort()).toEqual([locA, locB].sort());
  });

  it('still limits a Stock_Clerk', async () => {
    const res = await as(api().post('/api/v1/inventory/stock-in'), clerk).send({ bookId, locationId: locB, quantity: 1, version: 1, unitCost: 10 });
    expect(res.status).toBe(403);
    const list = await as(api().get(`/api/v1/branches/${branchId}/locations`), clerk);
    expect(list.body).toMatchObject({ accessMode: 'restricted', items: [{ id: locA }] });
  });
});
