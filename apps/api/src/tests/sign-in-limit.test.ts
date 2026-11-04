// #240 (#225 A1; owner decision 2a, 2026-11-04): the sign-in limit counts
// failed attempts only. Before, every request counted, and pre-login and login
// each counted, so a staff member who signed in five times in fifteen minutes
// (a shift change, a shared counter PC, a dropped session) was locked out.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';

const STAFF_PREFIX = 'signinlimit_';
const BRANCH_PREFIX = 'Sign-in Limit ';
const PASSWORD = 'Test@12345';

describe('Sign-in limit (#240)', () => {
  let branchId: number;
  const signIn = async (username: string, password: string) => {
    const pre = await request(getTestApp()).post('/api/v1/auth/pre-login').send({ username, password });
    if (pre.status !== 200) return pre.status;
    return (await request(getTestApp()).post('/api/v1/auth/login').send({ username, password, branchId })).status;
  };

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    for (const name of ['clerk', 'guessed']) await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role: 'Sales', branchId });
  });

  afterAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  it('lets a staff member sign in again and again (was: locked out after five sign-ins)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push(await signIn(`${STAFF_PREFIX}clerk`, PASSWORD));
    expect(statuses.every((s) => s === 200), JSON.stringify(statuses)).toBe(true);
  });

  it('still stops guessing: the eleventh failed attempt is refused, whatever the password', async () => {
    const statuses: number[] = [];
    const guessed = `${STAFF_PREFIX}guessed`;
    for (let i = 0; i < 10; i++) statuses.push(await signIn(guessed, 'Wrong-password-1!'));
    expect(statuses).not.toContain(429);
    expect(await signIn(guessed, 'Wrong-password-1!')).toBe(429);
    expect(await signIn(guessed, PASSWORD)).toBe(429);
  });
});
