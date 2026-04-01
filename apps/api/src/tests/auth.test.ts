import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTables } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';

describe('Auth — POST /api/auth/login', () => {
  let branchId: number;

  beforeAll(async () => {
    await cleanTables('refresh_tokens', 'staff_branch_roles', 'staff', 'branches');
    const branch = await createTestBranch({ name: 'Auth Test Branch' });
    branchId = branch.branchId;
  });

  afterAll(async () => {
    await cleanTables('refresh_tokens', 'staff_branch_roles', 'staff', 'branches');
  });

  it('returns 200 + accessToken on valid credentials', async () => {
    await createTestStaff({ username: 'auth_test_user', role: 'Admin', branchId });

    const app = getTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'auth_test_user', password: 'Test@12345', branchId });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.expiresIn).toBe(900);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('returns 401 on wrong password', async () => {
    await createTestStaff({ username: 'auth_wrong_pw', role: 'Admin', branchId });

    const app = getTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'auth_wrong_pw', password: 'WrongPassword!', branchId });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 on unknown username', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nonexistent_user', password: 'Test@12345', branchId });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 on wrong branchId', async () => {
    await createTestStaff({ username: 'auth_wrong_branch', role: 'Admin', branchId });

    const app = getTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'auth_wrong_branch', password: 'Test@12345', branchId: 99999 });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('BRANCH_ACCESS_DENIED');
  });

  it('returns 403 on deactivated account', async () => {
    const { staffId } = await createTestStaff({ username: 'auth_inactive', role: 'Admin', branchId });

    // Deactivate the staff
    const app = getTestApp();
    const { token } = await createTestStaff({ username: 'auth_admin_for_deactivate', role: 'Super_Admin', branchId });
    await request(app)
      .post(`/api/staff/${staffId}/deactivate`)
      .set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'auth_inactive', password: 'Test@12345', branchId });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('ACCOUNT_INACTIVE');
  });
});

describe('Auth — RBAC enforcement', () => {
  let branchId: number;

  beforeAll(async () => {
    await cleanTables('refresh_tokens', 'staff_branch_roles', 'staff', 'branches');
    const branch = await createTestBranch({ name: 'RBAC Test Branch' });
    branchId = branch.branchId;
  });

  afterAll(async () => {
    await cleanTables('refresh_tokens', 'staff_branch_roles', 'staff', 'branches');
  });

  it('Sales role cannot access Admin-only endpoint', async () => {
    const { token } = await createTestStaff({ username: 'rbac_sales', role: 'Sales', branchId });

    const app = getTestApp();
    const res = await request(app)
      .get('/api/staff')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('Admin role can access Admin-only endpoint', async () => {
    const { token } = await createTestStaff({ username: 'rbac_admin', role: 'Admin', branchId });

    const app = getTestApp();
    const res = await request(app)
      .get('/api/staff')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toBeDefined();
  });

  it('unauthenticated request returns 401', async () => {
    const app = getTestApp();
    const res = await request(app).get('/api/staff');
    expect(res.status).toBe(401);
  });
});
