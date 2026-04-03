import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'loc_test_';
const BRANCH_PREFIX = 'Loc Test ';

describe('Locations', () => {
  let adminToken: string;
  let managerToken: string;
  let salesToken: string;
  let branchId: number;
  let otherBranchId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Loc Test Branch' });
    branchId = branch.branchId;

    const other = await createTestBranch({ name: 'Loc Test Other Branch' });
    otherBranchId = other.branchId;

    const admin = await createTestStaff({ username: 'loc_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    const manager = await createTestStaff({ username: 'loc_test_manager', role: 'Manager', branchId });
    managerToken = manager.token;

    const sales = await createTestStaff({ username: 'loc_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;
  });

  afterAll(async () => {
    // Clean up locations for test branches first
    await db.query(
      `DELETE FROM locations WHERE branch_id IN (
         SELECT id FROM branches WHERE name LIKE $1
       )`,
      [`${BRANCH_PREFIX}%`],
    );
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── GET /api/branches/:branchId/locations ──────────────────────────────────

  it('any authenticated role can list locations', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${salesToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('unauthenticated request returns 401', async () => {
    const app = getTestApp();
    const res = await request(app).get(`/api/branches/${branchId}/locations`);
    expect(res.status).toBe(401);
  });

  // ── POST /api/branches/:branchId/locations ─────────────────────────────────

  it('Admin can create a location', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Test Floor A' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Test Floor A');
    expect(res.body.branchId).toBe(branchId);
    expect(res.body.isDefaultFulfillment).toBe(false);
  });

  it('Manager can create a location', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ name: 'Test Floor B' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Test Floor B');
  });

  it('Sales role cannot create a location (403)', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ name: 'Unauthorized Floor' });

    expect(res.status).toBe(403);
  });

  it('duplicate name within branch returns 409', async () => {
    const app = getTestApp();
    // Create once
    await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Duplicate Floor' });

    // Try again with same name
    const res = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Duplicate Floor' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_LOCATION_NAME');
  });

  it('same name in different branch is allowed', async () => {
    const app = getTestApp();
    // Create in branch
    await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Shared Name Floor' });

    // Create same name in other branch — needs admin token for that branch
    const otherAdmin = await createTestStaff({
      username: 'loc_test_other_admin',
      role: 'Admin',
      branchId: otherBranchId,
    });

    const res = await request(app)
      .post(`/api/branches/${otherBranchId}/locations`)
      .set('Authorization', `Bearer ${otherAdmin.token}`)
      .send({ name: 'Shared Name Floor' });

    expect(res.status).toBe(201);
  });

  // ── PUT /api/branches/:branchId/locations/:id (rename) ────────────────────

  it('Admin can rename a location', async () => {
    const app = getTestApp();
    // Create a location to rename
    const createRes = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'To Be Renamed' });
    const locId = createRes.body.id;

    const res = await request(app)
      .put(`/api/branches/${branchId}/locations/${locId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed Successfully' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Successfully');
  });

  it('rename to duplicate name within branch returns 409', async () => {
    const app = getTestApp();
    // Create two locations
    const a = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Rename Source' });

    await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Rename Target Exists' });

    // Try to rename source to target's name
    const res = await request(app)
      .put(`/api/branches/${branchId}/locations/${a.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Rename Target Exists' });

    expect(res.status).toBe(409);
  });

  // ── PUT /api/branches/:branchId/locations/:id/set-default ─────────────────

  it('set-default clears previous default and sets new one', async () => {
    const app = getTestApp();

    // Get current default
    const listRes = await request(app)
      .get(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`);
    const currentDefault = listRes.body.items.find((l: { isDefaultFulfillment: boolean }) => l.isDefaultFulfillment);

    // Create a new location to set as default
    const newLoc = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'New Default Location' });

    const setRes = await request(app)
      .put(`/api/branches/${branchId}/locations/${newLoc.body.id}/set-default`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(setRes.status).toBe(200);
    expect(setRes.body.isDefaultFulfillment).toBe(true);

    // Verify only one default exists
    const afterRes = await request(app)
      .get(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`);

    const defaults = afterRes.body.items.filter((l: { isDefaultFulfillment: boolean }) => l.isDefaultFulfillment);
    expect(defaults.length).toBe(1);
    expect(defaults[0].id).toBe(newLoc.body.id);

    // Restore original default if it existed
    if (currentDefault) {
      await request(app)
        .put(`/api/branches/${branchId}/locations/${currentDefault.id}/set-default`)
        .set('Authorization', `Bearer ${adminToken}`);
    }
  });

  it('set-default: only ONE default per branch after concurrent-style calls', async () => {
    const app = getTestApp();

    // Create two locations
    const locA = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Concurrency Test A' });

    const locB = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Concurrency Test B' });

    // Fire both set-default requests sequentially (simulates rapid UI clicks)
    await Promise.all([
      request(app)
        .put(`/api/branches/${branchId}/locations/${locA.body.id}/set-default`)
        .set('Authorization', `Bearer ${adminToken}`),
      request(app)
        .put(`/api/branches/${branchId}/locations/${locB.body.id}/set-default`)
        .set('Authorization', `Bearer ${adminToken}`),
    ]);

    // Exactly one default must remain
    const listRes = await request(app)
      .get(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`);

    const defaults = listRes.body.items.filter((l: { isDefaultFulfillment: boolean }) => l.isDefaultFulfillment);
    expect(defaults.length).toBe(1);
  });

  // ── DELETE /api/branches/:branchId/locations/:id ───────────────────────────

  it('Admin can delete a non-default location with no inventory', async () => {
    const app = getTestApp();
    const createRes = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'To Be Deleted' });

    const res = await request(app)
      .delete(`/api/branches/${branchId}/locations/${createRes.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Location deleted');
  });

  it('Sales role cannot delete a location (403)', async () => {
    const app = getTestApp();
    const createRes = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Sales Cannot Delete' });

    const res = await request(app)
      .delete(`/api/branches/${branchId}/locations/${createRes.body.id}`)
      .set('Authorization', `Bearer ${salesToken}`);

    expect(res.status).toBe(403);
  });

  // ── Audit log verification ─────────────────────────────────────────────────

  it('create location produces audit log entry', async () => {
    const app = getTestApp();
    const createRes = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Audit Test Location' });

    const locId = createRes.body.id;

    const audit = await db.query(
      `SELECT * FROM audit_logs
       WHERE entity_type = 'location' AND entity_id = $1 AND action = 'CREATE'
       ORDER BY id DESC LIMIT 1`,
      [String(locId)],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].branch_id).toBe(branchId);
  });

  it('rename produces audit log entry', async () => {
    const app = getTestApp();
    const createRes = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Audit Rename Source' });

    const locId = createRes.body.id;

    await request(app)
      .put(`/api/branches/${branchId}/locations/${locId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Audit Rename Target' });

    const audit = await db.query(
      `SELECT * FROM audit_logs
       WHERE entity_type = 'location' AND entity_id = $1 AND action = 'UPDATE'
       ORDER BY id DESC LIMIT 1`,
      [String(locId)],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('set-default produces audit log entry', async () => {
    const app = getTestApp();
    const createRes = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Audit Default Location' });

    const locId = createRes.body.id;

    await request(app)
      .put(`/api/branches/${branchId}/locations/${locId}/set-default`)
      .set('Authorization', `Bearer ${adminToken}`);

    const audit = await db.query(
      `SELECT * FROM audit_logs
       WHERE entity_type = 'location' AND entity_id = $1
         AND meta->>'action' = 'set_default'
       ORDER BY id DESC LIMIT 1`,
      [String(locId)],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('delete produces audit log entry', async () => {
    const app = getTestApp();
    const createRes = await request(app)
      .post(`/api/branches/${branchId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Audit Delete Location' });

    const locId = createRes.body.id;

    await request(app)
      .delete(`/api/branches/${branchId}/locations/${locId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const audit = await db.query(
      `SELECT * FROM audit_logs
       WHERE entity_type = 'location' AND entity_id = $1 AND action = 'DELETE'
       ORDER BY id DESC LIMIT 1`,
      [String(locId)],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });
});
