import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTables } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

describe('Branches', () => {
  let adminToken: string;
  let salesToken: string;
  let branchId: number;

  beforeAll(async () => {
    await cleanTables('refresh_tokens', 'staff_branch_roles', 'staff', 'branches');
    const branch = await createTestBranch({ name: 'Branch Test HQ' });
    branchId = branch.branchId;

    const admin = await createTestStaff({ username: 'branch_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    const sales = await createTestStaff({ username: 'branch_sales', role: 'Sales', branchId });
    salesToken = sales.token;
  });

  afterAll(async () => {
    await cleanTables('refresh_tokens', 'staff_branch_roles', 'staff', 'branches');
  });

  // ── Create ──────────────────────────────────────────────────────────────

  it('Admin can create a branch', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'New Test Branch',
        address: '456 Test Ave',
        contactInfo: { phone: '555-1234', email: 'new@branch.com' },
        operatingHours: { mon: '09:00-18:00' },
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('New Test Branch');
    expect(res.body.isActive).toBe(true);
    expect(res.body.id).toBeDefined();

    // Verify audit log written
    const audit = await db.query(
      `SELECT * FROM audit_logs WHERE entity_type = 'branch' AND entity_id = $1`,
      [String(res.body.id)],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].action).toBe('CREATE');
  });

  it('Sales role cannot create a branch (403)', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        name: 'Unauthorized Branch',
        address: '789 Fail St',
        contactInfo: {},
        operatingHours: {},
      });

    expect(res.status).toBe(403);
  });

  it('Duplicate branch name returns 409', async () => {
    const app = getTestApp();
    // Create once
    await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Duplicate Branch',
        address: '1 Dup St',
        contactInfo: {},
        operatingHours: {},
      });

    // Create again with same name
    const res = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Duplicate Branch',
        address: '2 Dup St',
        contactInfo: {},
        operatingHours: {},
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_BRANCH_NAME');
  });

  // ── List ────────────────────────────────────────────────────────────────

  it('GET /api/branches returns paginated list', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.page).toBe(1);
  });

  it('GET /api/branches returns 401 without token', async () => {
    const app = getTestApp();
    const res = await request(app).get('/api/branches');
    expect(res.status).toBe(401);
  });

  // ── Deactivate ──────────────────────────────────────────────────────────

  it('Admin can deactivate a branch', async () => {
    const app = getTestApp();

    // Create a branch to deactivate
    const createRes = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Branch To Deactivate',
        address: '99 Deactivate Rd',
        contactInfo: {},
        operatingHours: {},
      });

    const id = createRes.body.id;

    const deactivateRes = await request(app)
      .post(`/api/branches/${id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(deactivateRes.status).toBe(200);

    // Verify in DB
    const dbResult = await db.query(`SELECT is_active FROM branches WHERE id = $1`, [id]);
    expect(dbResult.rows[0].is_active).toBe(false);

    // Verify audit log
    const audit = await db.query(
      `SELECT * FROM audit_logs WHERE entity_type = 'branch' AND entity_id = $1 AND action = 'DEACTIVATE'`,
      [String(id)],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  // ── Delete with dependencies ─────────────────────────────────────────────

  it('Delete branch with staff assignments returns 409', async () => {
    const app = getTestApp();
    // branchId has staff assigned (from beforeAll)
    const res = await request(app)
      .delete(`/api/branches/${branchId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DEPENDENCY_CONFLICT');
    expect(res.body.details.blockingDependencies).toBeDefined();
  });
});
