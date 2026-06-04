/**
 * Pre-Login Bug Condition Exploration Test
 *
 * **Property 1: Bug Condition** — Pre-Login Raw Error Escapes + Lockout Never Written
 *
 * CRITICAL: This test MUST FAIL on unfixed code — failure confirms both bugs exist.
 * DO NOT attempt to fix the test or the code when it fails.
 * NOTE: This test encodes the expected behavior; it will validate the fix when it
 *       passes after implementation.
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import request from 'supertest';
import { db } from '../db/index.js';
import * as authService from '../modules/auth/auth.service.js';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff } from './helpers/testDb.js';

const STAFF_PREFIX = 'prelogin_bug_';

// Default security policy maxFailedAttempts (matches system_config seed value)
const MAX_FAILED_ATTEMPTS = 5;

// ── Test DB helpers ──────────────────────────────────────────────────────────

/**
 * Seeds a staff row with the given failed_login_attempts count.
 * Password is 'Test@12345'.
 */
async function seedStaffWithFailedAttempts(
  username: string,
  failedAttempts: number,
): Promise<{ staffId: number }> {
  const bcrypt = await import('bcrypt');
  const passwordHash = await bcrypt.hash('Test@12345', 10);

  const result = await db.query(
    `INSERT INTO staff (username, password_hash, full_name, is_active, failed_login_attempts)
     VALUES ($1, $2, $3, true, $4)
     RETURNING id`,
    [username, passwordHash, 'Bug Test Staff', failedAttempts],
  );
  return { staffId: result.rows[0].id as number };
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await cleanTestStaff(STAFF_PREFIX);
});

afterAll(async () => {
  await cleanTestStaff(STAFF_PREFIX);
});

afterEach(() => {
  // Always restore mocks after each test to avoid bleed-through
  vi.restoreAllMocks();
});

// ── Bug Condition Tests ───────────────────────────────────────────────────────

describe('Bug Condition: Pre-Login 500 Error & Missing Lockout', () => {
  /**
   * Bug 1a: db.query() throws a raw pg Error on the staff-lookup query.
   *
   * On UNFIXED code: the error propagates as a plain Error to errorHandler's
   * generic 500 branch. The status code will be 500, not 503.
   * The expected/fixed behavior is a structured 503 response.
   *
   * EXPECTED TO FAIL on unfixed code (status is 500, not 503).
   */
  it('Bug 1a: DB error on staff lookup returns structured 503 with error/message/requestId/timestamp', async () => {
    const app = getTestApp();

    // Simulate a raw pg error thrown by db.query (e.g. ECONNREFUSED or query failure)
    vi.spyOn(db, 'query').mockRejectedValueOnce(
      new Error('connection refused — simulated pg error'),
    );

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ username: 'any_user', password: 'any_password' });

    // The response MUST be a structured error with the standard shape.
    // On unfixed code: status is 500 (generic branch); this assertion FAILS.
    expect(res.status).toBe(503);

    // The body must have all four required fields.
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('requestId');
    expect(res.body).toHaveProperty('timestamp');
  });

  /**
   * Bug 1b: authService.getBranchesForUser() throws a raw Error after correct password.
   *
   * On UNFIXED code: the plain Error is forwarded via next(err) to errorHandler's
   * generic 500 branch. The status code will be 500, not 503.
   *
   * EXPECTED TO FAIL on unfixed code (status is 500, not 503).
   */
  it('Bug 1b: getBranchesForUser() raw error returns structured 503 with error/message/requestId/timestamp', async () => {
    const app = getTestApp();
    const username = `${STAFF_PREFIX}branches_err`;

    // Seed a valid staff row so credential validation passes
    await seedStaffWithFailedAttempts(username, 0);

    // Spy on getBranchesForUser to throw a raw query error (not an AppError)
    vi.spyOn(authService, 'getBranchesForUser').mockRejectedValueOnce(
      new Error('query timeout — simulated pg error'),
    );

    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ username, password: 'Test@12345' });

    // The response MUST be a structured error with the standard shape.
    // On unfixed code: status is 500 (generic branch); this assertion FAILS.
    expect(res.status).toBe(503);

    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('requestId');
    expect(res.body).toHaveProperty('timestamp');
  });

  /**
   * Bug 2: Lockout threshold reached via pre-login — locked_until never set.
   *
   * Seed staff with failed_login_attempts = maxFailedAttempts - 1 = 4.
   * Submit a wrong password. The pre-login route increments to 5 (= maxFailedAttempts)
   * but on UNFIXED code never writes locked_until.
   *
   * On UNFIXED code: locked_until remains NULL after the UPDATE.
   * EXPECTED TO FAIL on unfixed code (locked_until is NULL).
   */
  it('Bug 2: wrong password at threshold sets locked_until (not NULL) in the DB', async () => {
    const app = getTestApp();
    const username = `${STAFF_PREFIX}lockout_threshold`;

    // Seed staff with failed_login_attempts = maxFailedAttempts - 1
    const { staffId } = await seedStaffWithFailedAttempts(
      username,
      MAX_FAILED_ATTEMPTS - 1, // 4
    );

    // Submit a wrong password — this should be the last allowed attempt and trigger lockout
    const res = await request(app)
      .post('/api/auth/pre-login')
      .send({ username, password: 'WrongPassword!99' });

    // Expect a 400 error response (regardless of fix status)
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');

    // On UNFIXED code: locked_until IS NULL → this assertion FAILS.
    // On FIXED code: locked_until IS a future timestamp → assertion passes.
    const dbRow = await db.query(
      `SELECT locked_until FROM staff WHERE id = $1`,
      [staffId],
    );
    expect(dbRow.rows[0].locked_until).not.toBeNull();
  });
});
