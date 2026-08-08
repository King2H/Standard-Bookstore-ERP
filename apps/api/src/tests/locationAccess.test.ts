import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches, cleanStaffLocations } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'locaccess_test_';
const BRANCH_PREFIX = 'LocAccess Test ';

describe('Location Access Control', () => {
  let adminToken: string;
  let restrictedToken: string;
  let restrictedStaffId: number;
  let branchId: number;
  let otherBranchId: number;
  let locAId: number;
  let locBId: number;
  let otherBranchLocId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'LocAccess Test Branch' });
    branchId = branch.branchId;

    const otherBranch = await createTestBranch({ name: 'LocAccess Test Other Branch' });
    otherBranchId = otherBranch.branchId;

    // Create two locations in the main branch
    const locA = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, true) RETURNING id`,
      [branchId, 'LocAccess Floor A'],
    );
    locAId = locA.rows[0].id;

    const locB = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, false) RETURNING id`,
      [branchId, 'LocAccess Floor B'],
    );
    locBId = locB.rows[0].id;

    // Create a location in the other branch
    const otherLoc = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, true) RETURNING id`,
      [otherBranchId, 'LocAccess Other Floor'],
    );
    otherBranchLocId = otherLoc.rows[0].id;

    // Admin — manages location assignments
    const admin = await createTestStaff({ username: 'locaccess_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    // Restricted staff — will be given explicit location assignments
    const restricted = await createTestStaff({ username: 'locaccess_test_restricted', role: 'Stock_Clerk', branchId });
    restrictedToken = restricted.token;
    restrictedStaffId = restricted.staffId;
  });

  afterAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── GET /api/staff/:id/locations ───────────────────────────────────────────

  it('returns empty assignments (fallback mode) when no locations assigned', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get(`/api/staff/${restrictedStaffId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.fallbackMode).toBe(true);
  });

  it('unauthenticated request returns 401', async () => {
    const app = getTestApp();
    const res = await request(app).get(`/api/staff/${restrictedStaffId}/locations`);
    expect(res.status).toBe(401);
  });

  it('Stock_Clerk cannot read staff location assignments (403)', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get(`/api/staff/${restrictedStaffId}/locations`)
      .set('Authorization', `Bearer ${restrictedToken}`);
    expect(res.status).toBe(403);
  });

  // ── PUT /api/staff/:id/locations ───────────────────────────────────────────

  it('Admin can assign specific locations to staff', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put(`/api/staff/${restrictedStaffId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send([locAId]);

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('1 location');

    // Verify assignment persisted
    const getRes = await request(app)
      .get(`/api/staff/${restrictedStaffId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(getRes.body.items).toHaveLength(1);
    expect(getRes.body.items[0].locationId).toBe(locAId);
    expect(getRes.body.fallbackMode).toBe(false);
  });

  it('cross-branch location assignment is rejected (403)', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put(`/api/staff/${restrictedStaffId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send([otherBranchLocId]);

    expect(res.status).toBe(403);
  });

  it('invalid payload (non-array) returns 400', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put(`/api/staff/${restrictedStaffId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ locationIds: [locAId] });

    expect(res.status).toBe(400);
  });

  it('clearing assignments (empty array) restores fallback mode', async () => {
    const app = getTestApp();
    // First assign
    await request(app)
      .put(`/api/staff/${restrictedStaffId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send([locAId]);

    // Then clear
    const clearRes = await request(app)
      .put(`/api/staff/${restrictedStaffId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send([]);

    expect(clearRes.status).toBe(200);
    expect(clearRes.body.message).toContain('full branch access');

    const getRes = await request(app)
      .get(`/api/staff/${restrictedStaffId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(getRes.body.items).toHaveLength(0);
    expect(getRes.body.fallbackMode).toBe(true);
  });

  // ── assertLocationAccess (service-level) ──────────────────────────────────

  it('staff with no assignments can access all branch locations (fallback)', async () => {
    // Ensure no assignments
    await cleanStaffLocations(restrictedStaffId);

    const { assertLocationAccess } = await import('../modules/location/locationAccess.service.js');
    const staffCtx = { staffId: restrictedStaffId, role: 'Stock_Clerk', branchId };

    // Both locations in the branch should be accessible
    await expect(assertLocationAccess(locAId, staffCtx)).resolves.toBeUndefined();
    await expect(assertLocationAccess(locBId, staffCtx)).resolves.toBeUndefined();
  });

  it('staff with assigned locations can only access those locations', async () => {
    // Assign only locA
    await db.query(
      `INSERT INTO staff_locations (staff_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [restrictedStaffId, locAId],
    );

    const { assertLocationAccess } = await import('../modules/location/locationAccess.service.js');
    const staffCtx = { staffId: restrictedStaffId, role: 'Stock_Clerk', branchId };

    // locA — allowed
    await expect(assertLocationAccess(locAId, staffCtx)).resolves.toBeUndefined();

    // locB — blocked
    await expect(assertLocationAccess(locBId, staffCtx)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });

    // Clean up
    await cleanStaffLocations(restrictedStaffId);
  });

  it('cross-branch location access is always blocked', async () => {
    const { assertLocationAccess } = await import('../modules/location/locationAccess.service.js');
    const staffCtx = { staffId: restrictedStaffId, role: 'Stock_Clerk', branchId };

    await expect(assertLocationAccess(otherBranchLocId, staffCtx)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });

  // ── getAccessibleLocations ─────────────────────────────────────────────────

  it('getAccessibleLocations returns all branch locations in fallback mode', async () => {
    await cleanStaffLocations(restrictedStaffId);

    const { getAccessibleLocations } = await import('../modules/location/locationAccess.service.js');
    const staffCtx = { staffId: restrictedStaffId, role: 'Stock_Clerk', branchId };

    const locations = await getAccessibleLocations(staffCtx);
    const ids = locations.map(l => l.id);
    expect(ids).toContain(locAId);
    expect(ids).toContain(locBId);
  });

  it('getAccessibleLocations returns only assigned locations in restricted mode', async () => {
    await db.query(
      `INSERT INTO staff_locations (staff_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [restrictedStaffId, locAId],
    );

    const { getAccessibleLocations } = await import('../modules/location/locationAccess.service.js');
    const staffCtx = { staffId: restrictedStaffId, role: 'Stock_Clerk', branchId };

    const locations = await getAccessibleLocations(staffCtx);
    expect(locations).toHaveLength(1);
    expect(locations[0].id).toBe(locAId);

    await cleanStaffLocations(restrictedStaffId);
  });

  // ── Audit log ──────────────────────────────────────────────────────────────

  it('assigning locations produces an audit log entry', async () => {
    const app = getTestApp();
    await request(app)
      .put(`/api/staff/${restrictedStaffId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send([locAId, locBId]);

    const audit = await db.query(
      `SELECT * FROM audit_logs
       WHERE entity_type = 'staff_locations' AND entity_id = $1
       ORDER BY id DESC LIMIT 1`,
      [String(restrictedStaffId)],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].meta.action).toBe('set_location_restrictions');

    await cleanStaffLocations(restrictedStaffId);
  });

  it('clearing locations produces an audit log entry', async () => {
    const app = getTestApp();
    await request(app)
      .put(`/api/staff/${restrictedStaffId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send([]);

    const audit = await db.query(
      `SELECT * FROM audit_logs
       WHERE entity_type = 'staff_locations' AND entity_id = $1
       ORDER BY id DESC LIMIT 1`,
      [String(restrictedStaffId)],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].meta.action).toBe('clear_location_restrictions');
  });
});
