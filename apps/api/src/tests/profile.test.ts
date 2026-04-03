import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';

const STAFF_PREFIX = 'profile_test_';
const BRANCH_PREFIX = 'Profile Test ';

describe('Staff Profile', () => {
  let adminToken: string;
  let salesToken: string;
  let salesStaffId: number;
  let branchId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Profile Test Branch' });
    branchId = branch.branchId;

    const admin = await createTestStaff({ username: 'profile_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    const sales = await createTestStaff({ username: 'profile_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;
    salesStaffId = sales.staffId;
  });

  afterAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── GET /api/staff/me ──────────────────────────────────────────────────────

  it('any authenticated role can view their own profile', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get('/api/staff/me')
      .set('Authorization', `Bearer ${salesToken}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('profile_test_sales');
    expect(res.body.fullName).toBe('Test Staff');
    expect(res.body.isActive).toBe(true);
    expect(res.body.currentRole).toBe('Sales');
    expect(res.body.currentBranchId).toBe(branchId);
    expect(Array.isArray(res.body.roles)).toBe(true);
    expect(res.body.roles.length).toBeGreaterThan(0);
    // Password hash must never be returned
    expect(res.body.passwordHash).toBeUndefined();
    expect(res.body.password_hash).toBeUndefined();
  });

  it('Admin can also view their own profile', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get('/api/staff/me')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('profile_test_admin');
    expect(res.body.currentRole).toBe('Admin');
  });

  it('unauthenticated request returns 401', async () => {
    const app = getTestApp();
    const res = await request(app).get('/api/staff/me');
    expect(res.status).toBe(401);
  });

  // ── PUT /api/staff/me/password ─────────────────────────────────────────────

  it('staff can change their own password with correct current password', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put('/api/staff/me/password')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        currentPassword: 'Test@12345',
        newPassword: 'NewPass@9876',
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Password updated successfully');

    // Verify the new password works for login
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'profile_test_sales', password: 'NewPass@9876', branchId });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.accessToken).toBeDefined();
  });

  it('wrong current password returns 422', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put('/api/staff/me/password')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        currentPassword: 'WrongPassword!1',
        newPassword: 'AnotherNew@123',
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INVALID_CURRENT_PASSWORD');
  });

  it('weak new password returns 400', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put('/api/staff/me/password')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        currentPassword: 'NewPass@9876',
        newPassword: 'tooshort',
      });

    expect(res.status).toBe(400);
  });

  it('missing currentPassword returns 400', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put('/api/staff/me/password')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ newPassword: 'ValidPass@123' });

    expect(res.status).toBe(400);
  });

  it('unauthenticated password change returns 401', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put('/api/staff/me/password')
      .send({ currentPassword: 'Test@12345', newPassword: 'NewPass@9876' });

    expect(res.status).toBe(401);
  });

  it('password change produces audit log entry', async () => {
    const { db } = await import('../db/index.js');
    const audit = await db.query(
      `SELECT * FROM audit_logs
       WHERE entity_type = 'staff' AND entity_id = $1
         AND meta->>'action' = 'password_changed'
       ORDER BY id DESC LIMIT 1`,
      [String(salesStaffId)],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });
});
