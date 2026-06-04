/**
 * Pre-Login Preservation Property Tests
 *
 * **Property 2: Preservation** — Non-Buggy Pre-Login Flows Unchanged
 *
 * These tests verify that all currently-correct pre-login behaviours remain
 * unchanged both BEFORE and AFTER the bug fix is applied.
 *
 * Run on UNFIXED code first to establish the baseline (all tests must PASS).
 * Re-run after the fix (Task 3) to confirm no regressions.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { db } from '../db/index.js';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';

const STAFF_PREFIX = 'prelogin_pres_';
const BRANCH_PREFIX = 'PreLoginPres_';

// Default security policy values (from system_config seed)
const MAX_FAILED_ATTEMPTS = 5;

// ── DB Helpers ────────────────────────────────────────────────────────────────

async function seedBranch(name: string): Promise<number> {
  const result = await db.query(
    `INSERT INTO branches (name, address, contact_info, operating_hours, is_active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id`,
    [
      name,
      '1 Test Ave',
      JSON.stringify({ phone: '555-0000', email: 'test@branch.com' }),
      JSON.stringify({ mon: '09:00-18:00' }),
    ],
  );
  return result.rows[0].id as number;
}

async function seedStaff(opts: {
  username: string;
  password?: string;
  isActive?: boolean;
  failedAttempts?: number;
  lockedUntil?: Date | null;
  branchId?: number;
}): Promise<number> {
  const password = opts.password ?? 'Test@12345';
  const passwordHash = await bcrypt.hash(password, 10);
  const isActive = opts.isActive ?? true;
  const failedAttempts = opts.failedAttempts ?? 0;

  const result = await db.query(
    `INSERT INTO staff (username, password_hash, full_name, is_active, failed_login_attempts, locked_until)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [opts.username, passwordHash, 'Pres Test Staff', isActive, failedAttempts, opts.lockedUntil ?? null],
  );
  const staffId = result.rows[0].id as number;

  if (opts.branchId != null) {
    await db.query(
      `INSERT INTO staff_branch_roles (staff_id, branch_id, role)
       VALUES ($1, $2, 'Admin')
       ON CONFLICT DO NOTHING`,
      [staffId, opts.branchId],
    );
  }

  return staffId;
}

async function getStaffRow(staffId: number) {
  const result = await db.query(
    `SELECT failed_login_attempts, locked_until FROM staff WHERE id = $1`,
    [staffId],
  );
  return result.rows[0] as { failed_login_attempts: number; locked_until: Date | null };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let testBranchId: number;

beforeAll(async () => {
  await cleanTestStaff(STAFF_PREFIX);
  await cleanTestBranches(BRANCH_PREFIX);
  testBranchId = await seedBranch(`${BRANCH_PREFIX}Main`);
});

afterAll(async () => {
  await cleanTestStaff(STAFF_PREFIX);
  await cleanTestBranches(BRANCH_PREFIX);
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 3.1 — Valid credentials return 200 with correct response shape
// ─────────────────────────────────────────────────────────────────────────────

describe('3.1 Valid credentials → 200 OK with expected response shape', () => {
  it('returns 200 with { staffId, branches, isAllBranches, autoSelectBranchId } for a single-branch staff', async () => {
    const app = getTestApp();
    const username = `${STAFF_PREFIX}valid_single`;
    const staffId = await seedStaff({ username, branchId: testBranchId });

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ username, password: 'Test@12345' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('staffId', staffId);
    expect(res.body).toHaveProperty('branches');
    expect(Array.isArray(res.body.branches)).toBe(true);
    expect(res.body).toHaveProperty('isAllBranches');
    expect(res.body).toHaveProperty('autoSelectBranchId');

    // Single branch → autoSelectBranchId must equal that branch id
    expect(res.body.autoSelectBranchId).toBe(testBranchId);
  });

  it('returns 200 with autoSelectBranchId=null for multi-branch staff', async () => {
    const app = getTestApp();
    const username = `${STAFF_PREFIX}shape_multi`;
    const staffId = await seedStaff({ username, branchId: testBranchId });

    const extraBranchId = await seedBranch(`${BRANCH_PREFIX}Extra`);
    await db.query(
      `INSERT INTO staff_branch_roles (staff_id, branch_id, role)
       VALUES ($1, $2, 'Admin') ON CONFLICT DO NOTHING`,
      [staffId, extraBranchId],
    );

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ username, password: 'Test@12345' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('staffId', staffId);
    expect(res.body.branches).toHaveLength(2);
    expect(res.body).toHaveProperty('isAllBranches', false);
    expect(res.body.autoSelectBranchId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 3.3 — Unknown username → 400 VALIDATION_ERROR
// ─────────────────────────────────────────────────────────────────────────────

describe('3.3 Unknown username → 400 VALIDATION_ERROR', () => {
  it('returns 400 with VALIDATION_ERROR for a username not in the database', async () => {
    const app = getTestApp();

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ username: 'definitely_does_not_exist_xyz123', password: 'SomePassword!1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body).toHaveProperty('message');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 3.2 — Wrong password below lockout threshold
// ─────────────────────────────────────────────────────────────────────────────

describe('3.2 Wrong password below lockout threshold → 400, counter increments, locked_until stays NULL', () => {
  it('returns 400 and increments failed_login_attempts from 0 to 1, locked_until remains NULL', async () => {
    const app = getTestApp();
    const username = `${STAFF_PREFIX}wrong_pw_0`;
    const staffId = await seedStaff({ username, failedAttempts: 0 });

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ username, password: 'WrongPassword!99' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');

    const row = await getStaffRow(staffId);
    expect(row.failed_login_attempts).toBe(1);
    expect(row.locked_until).toBeNull();
  });

  it('returns 400 and increments failed_login_attempts from 2 to 3, locked_until remains NULL (threshold=5)', async () => {
    const app = getTestApp();
    const username = `${STAFF_PREFIX}wrong_pw_2`;
    const staffId = await seedStaff({ username, failedAttempts: 2 });

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ username, password: 'WrongPassword!99' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');

    const row = await getStaffRow(staffId);
    expect(row.failed_login_attempts).toBe(3);
    expect(row.locked_until).toBeNull();
  });

  // Edge: attempt just below threshold (maxFailedAttempts - 2) must NOT trigger lockout
  it('wrong password at maxFailedAttempts-2 → locked_until stays NULL, counter increments', async () => {
    const app = getTestApp();
    const username = `${STAFF_PREFIX}prop_below_edge`;
    const staffId = await seedStaff({ username, failedAttempts: MAX_FAILED_ATTEMPTS - 2 });

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ username, password: 'WrongPasswordProp!1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');

    const row = await getStaffRow(staffId);
    expect(row.failed_login_attempts).toBe(MAX_FAILED_ATTEMPTS - 1);
    expect(row.locked_until).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 3.4 — Already-locked account → 400 with lock message
// ─────────────────────────────────────────────────────────────────────────────

describe('3.4 Already-locked account → 400 with lock message', () => {
  it('returns 400 VALIDATION_ERROR with lock-related message for locked account', async () => {
    const app = getTestApp();
    const username = `${STAFF_PREFIX}locked_acct`;
    const lockedUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 min in the future
    await seedStaff({ username, lockedUntil, failedAttempts: MAX_FAILED_ATTEMPTS });

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ username, password: 'Test@12345' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    // The message should mention the lock/minutes
    expect(res.body.message).toMatch(/locked|minute/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 3.5 — Deactivated account → 400 with deactivated message
// ─────────────────────────────────────────────────────────────────────────────

describe('3.5 Deactivated account → 400 with deactivated message', () => {
  it('returns 400 VALIDATION_ERROR with deactivation message for inactive staff', async () => {
    const app = getTestApp();
    const username = `${STAFF_PREFIX}deactivated`;
    await seedStaff({ username, isActive: false });

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ username, password: 'Test@12345' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/deactivated/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 3.6 — Missing required fields → 400 schema validation error
// ─────────────────────────────────────────────────────────────────────────────

describe('3.6 Missing required fields → 400 schema validation error', () => {
  it('returns 400 VALIDATION_ERROR when username is missing', async () => {
    const app = getTestApp();

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ password: 'SomePassword!1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR when password is missing', async () => {
    const app = getTestApp();

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ username: 'some_user' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR when body is empty', async () => {
    const app = getTestApp();

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  // One parameterized sweep covering the remaining edge combinations
  it.each([
    { body: { username: '' }, label: 'empty username' },
    { body: { username: '', password: '' }, label: 'both fields empty' },
  ])('returns 400 for $label', async ({ body }) => {
    const app = getTestApp();
    const res = await request(app).post('/api/auth/pre-login').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
