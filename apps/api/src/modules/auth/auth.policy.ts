import type { RoleAssignment } from './auth.types.js';

/** Sign-in rules (#21, auth part 1). Pure functions; the service applies them. */

/** A session lasts at most one shift (owner decision 1a). */
export const SESSION_HOURS = 8;
export const ACCESS_TOKEN_SECONDS = 15 * 60;
/**
 * Two tabs can refresh at the same moment with the same cookie. The second,
 * arriving just after the first replaced the token, is not a theft.
 */
export const REUSE_GRACE_SECONDS = 30;

/**
 * The roles in effect in a branch: the ones held there. Staff with access to
 * all branches who hold none there act with the roles they hold in their
 * other branches, never with more (owner decision 2a). No roles: no access.
 */
export function effectiveRoles(assignments: RoleAssignment[], branchId: number, isAllBranches: boolean): string[] {
  const held = assignments.filter((a) => a.branchId === branchId).map((a) => a.role);
  const roles = held.length > 0 || !isAllBranches ? held : assignments.map((a) => a.role);
  return [...new Set(roles)];
}

/** Whether this failed sign-in, counted with the ones before it, locks the account. */
export function shouldLock(failedAttempts: number, maxFailedAttempts: number): boolean {
  return failedAttempts >= maxFailedAttempts;
}

export function isLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil > now;
}

export function minutesLeft(lockedUntil: Date, now: Date): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000));
}

/**
 * What a presented refresh token gets:
 * - rotate: unused, so it is exchanged for a new one;
 * - grace: replaced within the last REUSE_GRACE_SECONDS, by a parallel refresh;
 *   a new access token only, the cookie stays as the first refresh set it;
 * - reuse: replaced earlier, so someone else holds a copy; the session ends.
 */
export function refreshOutcome(usedAt: Date | null, now: Date): 'rotate' | 'grace' | 'reuse' {
  if (usedAt === null) return 'rotate';
  return now.getTime() - usedAt.getTime() <= REUSE_GRACE_SECONDS * 1000 ? 'grace' : 'reuse';
}

export function sessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000);
}
