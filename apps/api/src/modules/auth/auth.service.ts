import bcrypt from 'bcrypt';
import type { ProfileResponse } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { runInTenant, runWithoutTenant } from '../../db/tenantContext.js';
import { withTransaction } from '../../db/tx.js';
import { AuthError, BranchAccessError, BusinessError, NotFoundError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { getSignInLockoutPolicy } from '../config/config.service.js';
import * as policy from './auth.policy.js';
import * as repo from './auth.repository.js';
import { hashRefreshToken, newRefreshToken, signAccessToken } from './auth.tokens.js';
import type { BranchOption, IssuedTokens, RoleAssignment, SessionState, StaffCredentials } from './auth.types.js';

// Signing in and sessions (#21, auth part 1). Owner decisions: sessions with
// refresh tokens replaced at every refresh (1a); all-branch access never adds
// roles (2a); closed branches refuse sign-in (3a); one answer for every failed
// sign-in, counted atomically (4a); the session and roles are checked on
// every request (5a).

const BCRYPT_ROUNDS = 12;

/**
 * Compared against when the username does not exist, so the answer takes as
 * long as for a real account and the timing does not tell which names exist.
 */
const NO_SUCH_STAFF_HASH = '$2b$12$7sHemaVyEM8VQjtkjEmbzeCOs6R9XJUIeBxEizHiTgcOt8GRG9Rku';

function invalidCredentials(): AuthError {
  return new AuthError('INVALID_CREDENTIALS', 'Invalid username or password');
}

/**
 * Checks a username and password. Whatever is wrong (no such account, wrong
 * password, during a lockout too) the answer is INVALID_CREDENTIALS; only
 * with the right password does it say the account is locked or deactivated
 * (owner decision 4a, OWASP Authentication Cheat Sheet).
 */
/**
 * The tenant of the account signing in (#13): sign-in works in it from there
 * on. An unknown username gets the same answer, after the same slow hash
 * check, as a wrong password.
 */
async function tenantSigningIn(username: string, password: string): Promise<number> {
  const tenantId = await runWithoutTenant('finding the tenant of an account signing in', () => repo.tenantOfUsername(kysely, username));
  if (tenantId === undefined) {
    await bcrypt.compare(password, NO_SUCH_STAFF_HASH);
    throw invalidCredentials();
  }
  return tenantId;
}

async function checkCredentials(username: string, password: string): Promise<StaffCredentials> {
  const staff = await repo.findCredentials(kysely, username);
  if (!staff) {
    await bcrypt.compare(password, NO_SUCH_STAFF_HASH);
    throw invalidCredentials();
  }

  if (!(await bcrypt.compare(password, staff.passwordHash))) {
    await countFailure(staff.staffId, username);
    throw invalidCredentials();
  }

  const now = new Date();
  if (staff.lockedUntil && policy.isLocked(staff.lockedUntil, now)) {
    throw new AuthError('ACCOUNT_LOCKED', `Account is temporarily locked. Try again in ${policy.minutesLeft(staff.lockedUntil, now)} minute(s).`);
  }
  if (!staff.isActive) throw new AuthError('ACCOUNT_INACTIVE', 'This account has been deactivated');
  return staff;
}

async function countFailure(staffId: number, username: string): Promise<void> {
  const { maxFailedAttempts, lockoutMinutes } = await getSignInLockoutPolicy();
  await withTransaction({}, async (tx) => {
    const attempts = await repo.countFailedSignIn(tx, staffId);
    if (attempts === undefined || !policy.shouldLock(attempts, maxFailedAttempts)) return;
    if (await repo.lock(tx, staffId, lockoutMinutes)) {
      await insertOutboxEvent(tx, 'auth.failed_login_attempts', { username, attemptCount: attempts, branchId: null });
    }
  });
}

/**
 * The roles the staff member works with in the branch. Throws unless the
 * branch is open and they hold a role there, or have access to all branches
 * and hold a role anywhere.
 */
function rolesIn(
  branch: { isActive: boolean } | undefined,
  branchId: number,
  assignments: RoleAssignment[],
  isAllBranches: boolean,
): string[] {
  const roles = policy.effectiveRoles(assignments, branchId, isAllBranches);
  if (!branch || roles.length === 0) throw new AuthError('BRANCH_ACCESS_DENIED', `No access to branch ${branchId}`);
  if (!branch.isActive) throw new AuthError('BRANCH_INACTIVE', 'This branch is closed');
  return roles;
}

async function branchRoles(staffId: number, branchId: number, isAllBranches: boolean): Promise<string[]> {
  const [branch, assignments] = await Promise.all([repo.findBranch(kysely, branchId), repo.assignments(kysely, staffId)]);
  return rolesIn(branch, branchId, assignments, isAllBranches);
}

// ── Use cases ─────────────────────────────────────────────────────────────────

/** The first step of signing in: checks the password and lists the branches to choose from. */
export async function preLogin(
  username: string,
  password: string,
): Promise<{ staffId: number; branches: BranchOption[]; isAllBranches: boolean; autoSelectBranchId: number | null }> {
  const tenantId = await tenantSigningIn(username, password);
  return runInTenant(tenantId, async () => {
    const staff = await checkCredentials(username, password);
    const branches = await branchesOf(staff.staffId, staff.isAllBranches);
    const autoSelect = branches.length === 1 || (staff.isAllBranches && branches.length > 0) ? branches[0].branchId : null;
    return { staffId: staff.staffId, branches, isAllBranches: staff.isAllBranches, autoSelectBranchId: autoSelect };
  });
}

/** Signs in to a branch: opens a session and hands out its first tokens. */
export async function login(username: string, password: string, branchId: number): Promise<IssuedTokens> {
  const tenantId = await tenantSigningIn(username, password);
  return runInTenant(tenantId, () => openSession(tenantId, username, password, branchId));
}

async function openSession(tenantId: number, username: string, password: string, branchId: number): Promise<IssuedTokens> {
  const staff = await checkCredentials(username, password);
  const roles = await branchRoles(staff.staffId, branchId, staff.isAllBranches);

  const refreshToken = newRefreshToken();
  // Start and end from one clock, so the session lasts exactly its hours.
  const startedAt = new Date();
  const sessionExpiresAt = policy.sessionExpiry(startedAt);
  const sessionId = await withTransaction({}, async (tx) => {
    await repo.recordSignIn(tx, staff.staffId);
    const id = await repo.createSession(tx, { staffId: staff.staffId, branchId, startedAt, expiresAt: sessionExpiresAt });
    await repo.insertRefreshToken(tx, { sessionId: id, staffId: staff.staffId, tokenHash: hashRefreshToken(refreshToken) });
    return id;
  });

  return {
    accessToken: signAccessToken({ sid: sessionId, staffId: staff.staffId, branchId, tenantId }, roles),
    refreshToken,
    sessionExpiresAt,
    mustChangePassword: staff.mustChangePassword,
  };
}

function tokenRevoked(): AuthError {
  return new AuthError('TOKEN_REVOKED', 'Refresh token is invalid or expired');
}

/**
 * A new access token for the session, in the branch the session works in.
 * The refresh token is replaced; presenting a replaced one again ends the
 * session (owner decision 1a).
 */
export async function refresh(refreshToken: string): Promise<IssuedTokens> {
  const tenantId = await runWithoutTenant('finding the tenant of a refresh token', () =>
    repo.tenantOfRefreshToken(kysely, hashRefreshToken(refreshToken)),
  );
  if (tenantId === undefined) throw tokenRevoked();
  return runInTenant(tenantId, () => rotate(tenantId, refreshToken));
}

async function rotate(tenantId: number, refreshToken: string): Promise<IssuedTokens> {
  const result = await withTransaction({}, async (tx) => {
    const token = await repo.findRefreshToken(tx, hashRefreshToken(refreshToken));
    if (!token || token.revokedAt || token.expiresAt <= token.now || !token.staffActive) return { kind: 'revoked' as const };

    const outcome = policy.refreshOutcome(token.usedAt, token.now);
    if (outcome === 'reuse') {
      await repo.revokeSession(tx, token.sessionId, token.staffId, 'token_reuse');
      await insertAuditEntry(tx, {
        staffId: token.staffId,
        staffRole: 'SYSTEM',
        branchId: token.branchId,
        action: 'REVOKE',
        entityType: 'staff_session',
        entityId: token.sessionId,
        meta: { reason: 'token_reuse' },
      });
      return { kind: 'revoked' as const };
    }

    let next: string | null = null;
    if (outcome === 'rotate') {
      next = newRefreshToken();
      await repo.markRefreshTokenUsed(tx, token.tokenId);
      await repo.insertRefreshToken(tx, { sessionId: token.sessionId, staffId: token.staffId, tokenHash: hashRefreshToken(next) });
    }
    return { kind: 'ok' as const, token, next };
  });

  // Thrown after the transaction, so ending a reused token's session commits.
  if (result.kind === 'revoked') throw tokenRevoked();

  const { token, next } = result;
  const roles = await branchRoles(token.staffId, token.branchId, token.isAllBranches);
  return {
    accessToken: signAccessToken({ sid: token.sessionId, staffId: token.staffId, branchId: token.branchId, tenantId }, roles),
    refreshToken: next,
    sessionExpiresAt: token.expiresAt,
    mustChangePassword: token.mustChangePassword,
  };
}

export async function logout(staffId: number, sessionId: string): Promise<void> {
  await repo.revokeSession(kysely, sessionId, staffId, 'logout');
}

/** Moves the session to another branch; the next refresh stays there. */
export async function switchBranch(
  ctx: { staffId: number; sessionId: string },
  branchId: number,
): Promise<{ accessToken: string }> {
  const state = await repo.sessionState(kysely, ctx.staffId, ctx.sessionId);
  if (!state) throw tokenRevoked();
  const branch = await repo.findBranch(kysely, branchId);
  const roles = policy.effectiveRoles(state.assignments, branchId, state.isAllBranches);
  if (!branch || roles.length === 0) throw new BranchAccessError(branchId);
  if (!branch.isActive) throw new BusinessError('BRANCH_INACTIVE', 'This branch is closed');

  await repo.setSessionBranch(kysely, ctx.sessionId, ctx.staffId, branchId);
  return { accessToken: signAccessToken({ sid: ctx.sessionId, staffId: ctx.staffId, branchId, tenantId: state.tenantId }, roles) };
}

/** The open branches the staff member can work in, with the roles held in each. */
export async function branchesOf(staffId: number, isAllBranches: boolean): Promise<BranchOption[]> {
  const [branches, assignments] = await Promise.all([repo.openBranches(kysely), repo.assignments(kysely, staffId)]);
  return branches
    .map((b) => ({
      branchId: b.id,
      branchName: b.name,
      roles: [...new Set(assignments.filter((a) => a.branchId === b.id).map((a) => a.role))],
      isAllBranches,
    }))
    .filter((b) => policy.effectiveRoles(assignments, b.branchId, isAllBranches).length > 0);
}

/** For authenticate(): the session and the account behind an access token. */
export async function sessionState(staffId: number, sessionId: string): Promise<SessionState | undefined> {
  return repo.sessionState(kysely, staffId, sessionId);
}

export async function profile(ctx: { staffId: number; branchId: number; roles: string[] }): Promise<ProfileResponse> {
  const [row, locations] = await Promise.all([
    repo.profile(kysely, ctx.staffId),
    repo.assignedLocations(kysely, ctx.staffId, ctx.branchId),
  ]);
  if (!row) throw new NotFoundError('Staff');
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    mustChangePassword: row.must_change_password,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    passwordChangedAt: row.password_changed_at?.toISOString() ?? null,
    isLocked: policy.isLocked(row.locked_until, new Date()),
    isAllBranches: row.is_all_branches,
    roles: row.roles,
    currentRole: ctx.roles[0],
    currentRoles: ctx.roles,
    currentBranchId: ctx.branchId,
    locationAccess: {
      mode: locations.length > 0 ? 'restricted' : 'full',
      locations: locations.map((l) => ({ id: l.id, name: l.name, isDefaultFulfillment: l.is_default_fulfillment })),
    },
  };
}

/** Changes the staff member's own password and ends their other sessions. */
export async function changePassword(
  ctx: { staffId: number; sessionId: string; role: string; branchId: number },
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const hash = await repo.findPasswordHash(kysely, ctx.staffId);
  if (!hash) throw new NotFoundError('Staff');
  if (!(await bcrypt.compare(currentPassword, hash))) {
    throw new BusinessError('INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
  }
  // Keeping the password would end a forced change with the temporary one an admin set.
  if (newPassword === currentPassword) {
    throw new BusinessError('PASSWORD_UNCHANGED', 'The new password must differ from the current one');
  }
  const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await withTransaction({}, async (tx) => {
    await repo.setPassword(tx, ctx.staffId, newHash);
    await repo.revokeSessionsOf(tx, ctx.staffId, 'password_changed', ctx.sessionId);
    await insertAuditEntry(tx, {
      staffId: ctx.staffId,
      staffRole: ctx.role,
      branchId: ctx.branchId,
      action: 'UPDATE',
      entityType: 'staff',
      entityId: ctx.staffId,
      meta: { action: 'password_changed', otherSessionsEnded: true },
    });
  });
}
