/**
 * auth-sessions.test.ts
 *
 * Signing in and sessions (#21, auth part 1), owner decisions 1a–5a:
 * - 1a: a session keeps its branch and lasts one shift; the refresh token is
 *   replaced at every refresh, and a replaced one presented again ends the
 *   session (a parallel refresh within 30 seconds excepted);
 * - 2a: access to all branches never adds roles;
 * - 3a: nobody signs in or switches to a closed branch;
 * - 4a: one answer for every failed sign-in, and failures counted atomically;
 * - 5a: the session and roles are read on every request, so logout, a
 *   password change and role changes apply at once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'auth_sess_test_';
const BRANCH_PREFIX = 'Auth Sessions Test ';
const PASSWORD = 'Test@12345';

const api = () => request(getTestApp());

function claims(token: string): { branchId: number; role: string; roles: string[] } {
  return jwt.decode(token) as { branchId: number; role: string; roles: string[] };
}

/** The refreshToken cookie a response set, as a Cookie header value, or undefined. */
function refreshCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith('refreshToken=') && !c.startsWith('refreshToken=;'));
  return cookie?.split(';')[0];
}

async function login(username: string, branchId: number, password = PASSWORD) {
  const res = await api().post('/api/v1/auth/login').send({ username, password, branchId });
  return { res, token: res.body.accessToken as string, cookie: refreshCookie(res)! };
}

const refresh = (cookie: string) => api().post('/api/v1/auth/refresh').set('Cookie', cookie);
const get = (path: string, token: string) => api().get(path).set('Authorization', `Bearer ${token}`);

describe('Auth sessions', () => {
  let branchA: number;
  let branchB: number;
  let closedBranch: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    closedBranch = (await createTestBranch({ name: `${BRANCH_PREFIX}Closed` })).branchId;
    await db.query(`UPDATE branches SET is_active = false WHERE id = $1`, [closedBranch]);
  });

  afterAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  describe('the session keeps its branch (owner decision 1a)', () => {
    it('stays in the branch switched to when the token is refreshed (was: back to the sign-in branch)', async () => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}switch`, role: 'Sales', branchId: branchA });
      await db.query(`INSERT INTO staff_branch_roles (staff_id, branch_id, role) VALUES ($1, $2, 'Sales')`, [s.staffId, branchB]);
      const { token, cookie } = await login(`${STAFF_PREFIX}switch`, branchA);

      const switched = await api().post('/api/v1/auth/switch-branch').set('Authorization', `Bearer ${token}`).send({ branchId: branchB });
      expect(switched.status).toBe(200);
      expect(claims(switched.body.accessToken).branchId).toBe(branchB);

      const refreshed = await refresh(cookie);
      expect(refreshed.status).toBe(200);
      expect(claims(refreshed.body.accessToken).branchId).toBe(branchB);
    });

    it('refreshes with more than 100 sessions open (was: only the first 100 refresh tokens were checked)', async () => {
      // 12 staff signed in 9 times each: 108 open sessions besides the one refreshed.
      for (let i = 0; i < 12; i++) {
        await createTestStaff({ username: `${STAFF_PREFIX}crowd${i}`, role: 'Sales', branchId: branchA });
        for (let n = 0; n < 9; n++) expect((await login(`${STAFF_PREFIX}crowd${i}`, branchA)).res.status).toBe(200);
      }
      await createTestStaff({ username: `${STAFF_PREFIX}last`, role: 'Sales', branchId: branchA });
      const { cookie } = await login(`${STAFF_PREFIX}last`, branchA);

      expect((await refresh(cookie)).status).toBe(200);
    }, 60_000);

    it('lasts one shift: the cookie and the session end after 8 hours (was: 7 days in the database)', async () => {
      await createTestStaff({ username: `${STAFF_PREFIX}shift`, role: 'Sales', branchId: branchA });
      const { res, token, cookie } = await login(`${STAFF_PREFIX}shift`, branchA);
      const { sid } = jwt.decode(token) as { sid: string };

      const setCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refreshToken='))!;
      const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)![1]);
      expect(maxAge).toBeGreaterThan(8 * 3600 - 60);
      expect(maxAge).toBeLessThanOrEqual(8 * 3600);

      // The sign-in's own session (the test helper opened another), measured
      // exactly: its start and end come from one clock (was: the end from the
      // API's, the start from the database's, so it fell short by the gap).
      const { rows } = await db.query(
        `SELECT EXTRACT(EPOCH FROM expires_at - created_at)::text AS seconds FROM staff_sessions WHERE id = $1`,
        [sid],
      );
      expect(rows[0].seconds).toBe('28800.000000');

      await db.query(`UPDATE staff_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [sid]);
      expect((await refresh(cookie)).status).toBe(401);
    });
  });

  describe('refresh tokens are replaced at every refresh (owner decision 1a)', () => {
    it('hands out a new refresh token, and a parallel refresh within 30 seconds keeps working', async () => {
      await createTestStaff({ username: `${STAFF_PREFIX}rotate`, role: 'Sales', branchId: branchA });
      const { cookie } = await login(`${STAFF_PREFIX}rotate`, branchA);

      const first = await refresh(cookie);
      expect(first.status).toBe(200);
      const next = refreshCookie(first);
      expect(next).toBeDefined();
      expect(next).not.toBe(cookie);

      // Another tab, same old cookie, a moment later: an access token, the cookie left as it is.
      const parallel = await refresh(cookie);
      expect(parallel.status).toBe(200);
      expect(refreshCookie(parallel)).toBeUndefined();

      expect((await refresh(next!)).status).toBe(200);
    });

    it('ends the session when a replaced refresh token is presented again later (was: reusable for 7 days)', async () => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}reuse`, role: 'Sales', branchId: branchA });
      const { token, cookie } = await login(`${STAFF_PREFIX}reuse`, branchA);
      const next = refreshCookie(await refresh(cookie))!;
      await db.query(`UPDATE refresh_tokens SET used_at = now() - interval '1 minute' WHERE staff_id = $1 AND used_at IS NOT NULL`, [s.staffId]);

      const stolen = await refresh(cookie);
      expect(stolen.status).toBe(401);
      expect(stolen.body.error).toBe('TOKEN_REVOKED');

      // The whole session ends: the current refresh token and the access token too.
      expect((await refresh(next)).status).toBe(401);
      const after = await get('/api/v1/staff/me', token);
      expect(after.status).toBe(401);
      expect(after.body.error).toBe('TOKEN_REVOKED');

      const { rows } = await db.query(`SELECT revoked_reason FROM staff_sessions WHERE staff_id = $1 AND revoked_at IS NOT NULL`, [s.staffId]);
      expect(rows.map((r) => r.revoked_reason)).toEqual(['token_reuse']);
    });
  });

  describe('all-branch access never adds roles (owner decision 2a)', () => {
    it('signs in to another branch with the roles held elsewhere (was: Admin)', async () => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}allbr`, role: 'Sales', branchId: branchA });
      await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [s.staffId]);

      const { res, token } = await login(`${STAFF_PREFIX}allbr`, branchB);
      expect(res.status).toBe(200);
      expect(claims(token).roles).toEqual(['Sales']);

      // Staff details are for Admin and Manager.
      expect((await get(`/api/v1/staff/${s.staffId}`, token)).status).toBe(403);
      const me = await get('/api/v1/staff/me', token);
      expect(me.body.currentRoles).toEqual(['Sales']);
    });

    it('cannot sign in with no role anywhere', async () => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}norole`, role: 'Sales', branchId: branchA });
      await db.query(`DELETE FROM staff_branch_roles WHERE staff_id = $1`, [s.staffId]);
      await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [s.staffId]);

      const { res } = await login(`${STAFF_PREFIX}norole`, branchA);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('BRANCH_ACCESS_DENIED');
    });
  });

  describe('closed branches (owner decision 3a)', () => {
    it('refuses to sign in to a closed branch (was: signed in)', async () => {
      await createTestStaff({ username: `${STAFF_PREFIX}closed`, role: 'Sales', branchId: closedBranch });
      const { res } = await login(`${STAFF_PREFIX}closed`, closedBranch);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('BRANCH_INACTIVE');
    });

    it('does not offer a closed branch, and refuses to switch to it', async () => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}closedsw`, role: 'Sales', branchId: branchA });
      await db.query(`INSERT INTO staff_branch_roles (staff_id, branch_id, role) VALUES ($1, $2, 'Sales')`, [s.staffId, closedBranch]);

      const pre = await api().post('/api/v1/auth/pre-login').send({ username: `${STAFF_PREFIX}closedsw`, password: PASSWORD });
      expect(pre.status).toBe(200);
      expect(pre.body.branches.map((b: { branchId: number }) => b.branchId)).toEqual([branchA]);

      const switched = await api().post('/api/v1/auth/switch-branch').set('Authorization', `Bearer ${s.token}`).send({ branchId: closedBranch });
      expect(switched.status).toBe(422);
      expect(switched.body.error).toBe('BRANCH_INACTIVE');
    });
  });

  describe('failed sign-ins (owner decision 4a)', () => {
    it('counts parallel wrong passwords and locks the account (was: counted as one)', async () => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}parallel`, role: 'Sales', branchId: branchA });
      const lockEvents = async () =>
        (await db.query(
          `SELECT count(*)::int AS n FROM outbox WHERE event_type = 'auth.failed_login_attempts' AND payload->>'username' = $1`,
          [`${STAFF_PREFIX}parallel`],
        )).rows[0].n as number;
      const eventsBefore = await lockEvents();
      await Promise.all(
        Array.from({ length: 8 }, () => api().post('/api/v1/auth/login').send({ username: `${STAFF_PREFIX}parallel`, password: 'Wrong@12345', branchId: branchA })),
      );
      const { rows } = await db.query(`SELECT failed_login_attempts, locked_until > now() AS locked FROM staff WHERE id = $1`, [s.staffId]);
      expect(rows[0].locked).toBe(true);
      expect(rows[0].failed_login_attempts).toBeGreaterThanOrEqual(5);
      // One notification for the lock, not one per attempt.
      expect((await lockEvents()) - eventsBefore).toBe(1);
    });

    it('gives a deactivated or locked account with a wrong password the same answer as an unknown one (was: ACCOUNT_INACTIVE)', async () => {
      const inactive = await createTestStaff({ username: `${STAFF_PREFIX}gone`, role: 'Sales', branchId: branchA });
      await db.query(`UPDATE staff SET is_active = false WHERE id = $1`, [inactive.staffId]);
      const locked = await createTestStaff({ username: `${STAFF_PREFIX}lockd`, role: 'Sales', branchId: branchA });
      await db.query(`UPDATE staff SET locked_until = now() + interval '30 minutes', failed_login_attempts = 5 WHERE id = $1`, [locked.staffId]);

      for (const username of [`${STAFF_PREFIX}gone`, `${STAFF_PREFIX}lockd`, `${STAFF_PREFIX}nobody`]) {
        for (const path of ['/api/v1/auth/login', '/api/v1/auth/pre-login']) {
          const res = await api().post(path).send({ username, password: 'Wrong@12345', branchId: branchA });
          expect(res.status, `${path} ${username}`).toBe(401);
          expect(res.body.error, `${path} ${username}`).toBe('INVALID_CREDENTIALS');
        }
      }

      // With the right password, they learn why.
      expect((await login(`${STAFF_PREFIX}gone`, branchA)).res.body.error).toBe('ACCOUNT_INACTIVE');
      expect((await login(`${STAFF_PREFIX}lockd`, branchA)).res.body.error).toBe('ACCOUNT_LOCKED');
    });

    it('does not count wrong passwords during a lockout, and starts again once it runs out', async () => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}expire`, role: 'Sales', branchId: branchA });
      await db.query(`UPDATE staff SET locked_until = now() + interval '30 minutes', failed_login_attempts = 5 WHERE id = $1`, [s.staffId]);
      await login(`${STAFF_PREFIX}expire`, branchA, 'Wrong@12345');
      let { rows } = await db.query(`SELECT failed_login_attempts FROM staff WHERE id = $1`, [s.staffId]);
      expect(rows[0].failed_login_attempts).toBe(5);

      await db.query(`UPDATE staff SET locked_until = now() - interval '1 minute' WHERE id = $1`, [s.staffId]);
      await login(`${STAFF_PREFIX}expire`, branchA, 'Wrong@12345');
      ({ rows } = await db.query(`SELECT failed_login_attempts, locked_until FROM staff WHERE id = $1`, [s.staffId]));
      expect(rows[0].failed_login_attempts).toBe(1);
      expect(rows[0].locked_until).toBeNull();
    });
  });

  describe('changes apply at once (owner decision 5a)', () => {
    it('ends the other sessions when the password is changed (was: they stayed signed in)', async () => {
      await createTestStaff({ username: `${STAFF_PREFIX}pwd`, role: 'Sales', branchId: branchA });
      const here = await login(`${STAFF_PREFIX}pwd`, branchA);
      const elsewhere = await login(`${STAFF_PREFIX}pwd`, branchA);

      const changed = await api()
        .put('/api/v1/staff/me/password')
        .set('Authorization', `Bearer ${here.token}`)
        .send({ currentPassword: PASSWORD, newPassword: 'New@Passw0rd1' });
      expect(changed.status).toBe(200);

      expect((await refresh(elsewhere.cookie)).status).toBe(401);
      expect((await get('/api/v1/staff/me', elsewhere.token)).status).toBe(401);
      // The session that changed it carries on.
      expect((await get('/api/v1/staff/me', here.token)).status).toBe(200);
      expect((await refresh(here.cookie)).status).toBe(200);
    });

    it('ends the session at logout, for the access token too', async () => {
      await createTestStaff({ username: `${STAFF_PREFIX}logout`, role: 'Sales', branchId: branchA });
      const { token, cookie } = await login(`${STAFF_PREFIX}logout`, branchA);

      expect((await api().post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`)).status).toBe(200);
      expect((await get('/api/v1/staff/me', token)).status).toBe(401);
      expect((await refresh(cookie)).status).toBe(401);
    });

    it('applies a role change to the next request', async () => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}demote`, role: 'Manager', branchId: branchA });
      const { token } = await login(`${STAFF_PREFIX}demote`, branchA);
      // Staff details are for Admin and Manager.
      expect((await get(`/api/v1/staff/${s.staffId}`, token)).status).toBe(200);

      await db.query(`UPDATE staff_branch_roles SET role = 'Sales' WHERE staff_id = $1`, [s.staffId]);
      expect((await get(`/api/v1/staff/${s.staffId}`, token)).status).toBe(403);

      await db.query(`DELETE FROM staff_branch_roles WHERE staff_id = $1`, [s.staffId]);
      const res = await get('/api/v1/staff/me', token);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('BRANCH_ACCESS_DENIED');
    });

    it('ends the sessions of a deactivated staff member', async () => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}deact`, role: 'Sales', branchId: branchA });
      const admin = await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId: branchA });
      const { cookie } = await login(`${STAFF_PREFIX}deact`, branchA);

      expect((await api().post(`/api/v1/staff/${s.staffId}/deactivate`).set('Authorization', `Bearer ${admin.token}`)).status).toBe(200);
      expect((await refresh(cookie)).status).toBe(401);
      const { rows } = await db.query(`SELECT revoked_reason FROM staff_sessions WHERE staff_id = $1 AND revoked_at IS NOT NULL LIMIT 1`, [s.staffId]);
      expect(rows[0].revoked_reason).toBe('deactivated');
    });
  });
});
