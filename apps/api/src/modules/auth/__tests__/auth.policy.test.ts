import { describe, it, expect } from 'vitest';
import { effectiveRoles, isLocked, minutesLeft, refreshOutcome, sessionExpiry, shouldLock } from '../auth.policy.js';

const held = [
  { branchId: 1, role: 'Sales' },
  { branchId: 1, role: 'Stock_Clerk' },
  { branchId: 2, role: 'Manager' },
  { branchId: 2, role: 'Sales' },
];

describe('effectiveRoles', () => {
  it('gives the roles held in the branch', () => {
    expect(effectiveRoles(held, 1, false)).toEqual(['Sales', 'Stock_Clerk']);
    expect(effectiveRoles(held, 1, true)).toEqual(['Sales', 'Stock_Clerk']);
  });

  it('gives nothing in a branch without a role, unless the staff member has access to all branches', () => {
    expect(effectiveRoles(held, 3, false)).toEqual([]);
  });

  it('gives all-branch staff the roles they hold elsewhere, never Admin', () => {
    expect(effectiveRoles(held, 3, true)).toEqual(['Sales', 'Stock_Clerk', 'Manager']);
    expect(effectiveRoles([], 3, true)).toEqual([]);
  });
});

describe('lockout', () => {
  const now = new Date('2026-10-11T10:00:00Z');

  it('locks at the limit', () => {
    expect(shouldLock(4, 5)).toBe(false);
    expect(shouldLock(5, 5)).toBe(true);
  });

  it('is locked only until the time runs out', () => {
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked(new Date('2026-10-11T10:00:01Z'), now)).toBe(true);
    expect(isLocked(new Date('2026-10-11T10:00:00Z'), now)).toBe(false);
  });

  it('rounds the minutes left up, and never says zero', () => {
    expect(minutesLeft(new Date('2026-10-11T10:29:30Z'), now)).toBe(30);
    expect(minutesLeft(new Date('2026-10-11T10:00:01Z'), now)).toBe(1);
  });
});

describe('refreshOutcome', () => {
  const now = new Date('2026-10-11T10:00:00Z');

  it('replaces an unused token', () => {
    expect(refreshOutcome(null, now)).toBe('rotate');
  });

  it('treats a token replaced in the last 30 seconds as a parallel refresh', () => {
    expect(refreshOutcome(new Date('2026-10-11T09:59:31Z'), now)).toBe('grace');
    expect(refreshOutcome(new Date('2026-10-11T09:59:30Z'), now)).toBe('grace');
  });

  it('treats a token replaced earlier as reused', () => {
    expect(refreshOutcome(new Date('2026-10-11T09:59:29Z'), now)).toBe('reuse');
  });
});

describe('sessionExpiry', () => {
  it('ends a session one shift (8 hours) after sign-in', () => {
    expect(sessionExpiry(new Date('2026-10-11T08:00:00Z')).toISOString()).toBe('2026-10-11T16:00:00.000Z');
  });
});
