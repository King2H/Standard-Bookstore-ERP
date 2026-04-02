import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';

// All test data uses the prefix 'auth_test_' so cleanup is surgical
const STAFF_PREFIX = 'auth_test_';
const BRANCH_PREFIX = 'Auth Test ';

describe('Auth — POST /api/auth/login', () => {
  let branchId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    const branch = await createTestBranch({ name: 'Auth Test Branch' });
    branchId = branch.branchId;
  });

  afterAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
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
    await createTestStaff({ username: 'auth_test_wrong_pw', role: 'Admin', branchId });

    const app = getTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'auth_test_wrong_pw', password: 'WrongPassword!', branchId });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 on unknown username', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'auth_test_nonexistent_xyz', password: 'Test@12345', branchId });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 on wrong branchId', async () => {
    await createTestStaff({ username: 'auth_test_wrong_branch', role: 'Admin', branchId });

    const app = getTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'auth_test_wrong_branch', password: 'Test@12345', branchId: 99999 });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('BRANCH_ACCESS_DENIED');
  });

  it('returns 401 on deactivated account', async () => {
    const { staffId } = await createTestStaff({ username: 'auth_test_inactive', role: 'Admin', branchId });
    const { token } = await createTestStaff({ username: 'auth_test_deactivator', role: 'Super_Admin', branchId });

    const app = getTestApp();
    await request(app)
      .post(`/api/staff/${staffId}/deactivate`)
      .set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'auth_test_inactive', password: 'Test@12345', branchId });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('ACCOUNT_INACTIVE');
  });
});

describe('Auth — RBAC enforcement', () => {
  let branchId: number;

  beforeAll(async () => {
    await cleanTestStaff('rbac_test_');
    await cleanTestBranches('RBAC Test ');
    const branch = await createTestBranch({ name: 'RBAC Test Branch' });
    branchId = branch.branchId;
  });

  afterAll(async () => {
    await cleanTestStaff('rbac_test_');
    await cleanTestBranches('RBAC Test ');
  });

  it('Sales role cannot access Admin-only endpoint', async () => {
    const { token } = await createTestStaff({ username: 'rbac_test_sales', role: 'Sales', branchId });

    const app = getTestApp();
    const res = await request(app)
      .get('/api/staff')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('Admin role can access Admin-only endpoint', async () => {
    const { token } = await createTestStaff({ username: 'rbac_test_admin', role: 'Admin', branchId });

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
