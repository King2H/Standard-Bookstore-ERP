import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #38: a pending password change is enforced by the API, not only by the
// browser. Until the password is changed, only the endpoints needed to change
// it answer; everything else gets 403 PASSWORD_CHANGE_REQUIRED.

const STAFF_PREFIX = 'fpc_test_';
const BRANCH_PREFIX = 'FPC Test Branch';
const PASSWORD = 'Test@12345';
const NEW_PASSWORD = 'Changed#2026pw';

describe('Forced password change', () => {
  const api = () => request(getTestApp());
  let branchId: number;
  let adminToken: string;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX} A` })).branchId;
    adminToken = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId })).token;
  });

  afterAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  async function staffWithPendingChange(name: string) {
    const staff = await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role: 'Manager', branchId });
    await db.query(`UPDATE staff SET must_change_password = true WHERE id = $1`, [staff.staffId]);
    return staff;
  }

  async function login(username: string, password = PASSWORD) {
    const res = await api().post('/api/v1/auth/login').send({ username, password, branchId });
    expect(res.status).toBe(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='))!.split(';')[0];
    return { token: res.body.accessToken as string, mustChangePassword: res.body.mustChangePassword, refreshCookie };
  }

  const get = (path: string, token: string) => api().get(path).set('Authorization', `Bearer ${token}`);

  it('blocks every other endpoint after login, and says why (was: only the browser blocked it)', async () => {
    await staffWithPendingChange('login');
    const session = await login(`${STAFF_PREFIX}login`);
    expect(session.mustChangePassword).toBe(true);

    for (const path of ['/api/v1/orders', '/api/v1/suppliers', '/api/v1/reports/sales']) {
      const res = await get(path, session.token);
      expect({ path, status: res.status, error: res.body.error }).toEqual({ path, status: 403, error: 'PASSWORD_CHANGE_REQUIRED' });
    }
    const switched = await api()
      .post('/api/v1/auth/switch-branch')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ branchId });
    expect(switched.status).toBe(403);
  });

  it('still answers the endpoints needed to change the password', async () => {
    const staff = await staffWithPendingChange('allowed');
    expect((await get('/api/v1/staff/me', staff.token)).status).toBe(200);
    expect((await get('/api/v1/auth/branches', staff.token)).status).toBe(200);
  });

  it('reports the pending change on refresh, so a page reload keeps the block (was: lost on reload)', async () => {
    await staffWithPendingChange('refresh');
    const session = await login(`${STAFF_PREFIX}refresh`);

    const refreshed = await api().post('/api/v1/auth/refresh').set('Cookie', session.refreshCookie);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.mustChangePassword).toBe(true);
    expect((await get('/api/v1/orders', refreshed.body.accessToken)).status).toBe(403);
  });

  it('blocks an open session as soon as an admin resets the password', async () => {
    const staff = await createTestStaff({ username: `${STAFF_PREFIX}reset`, role: 'Manager', branchId });
    expect((await get('/api/v1/orders', staff.token)).status).toBe(200);

    const reset = await api()
      .post(`/api/v1/staff/${staff.staffId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ temporaryPassword: 'Temp#2026pass' });
    expect(reset.status).toBe(200);

    const after = await get('/api/v1/orders', staff.token);
    expect(after.status).toBe(403);
    expect(after.body.error).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('lifts the block as soon as the password is changed, with the same token', async () => {
    await staffWithPendingChange('change');
    const session = await login(`${STAFF_PREFIX}change`);

    const changed = await api()
      .put('/api/v1/staff/me/password')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(200);

    expect((await get('/api/v1/orders', session.token)).status).toBe(200);
    const refreshed = await api().post('/api/v1/auth/refresh').set('Cookie', session.refreshCookie);
    expect(refreshed.body.mustChangePassword).toBe(false);
  });
});
