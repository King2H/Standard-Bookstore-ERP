import { sql } from 'kysely';
import type { Queryable } from '../../db/tx.js';
import type { RefreshTokenRecord, RevokeReason, RoleAssignment, SessionState, StaffCredentials } from './auth.types.js';

// Signing in, sessions and refresh tokens (#21). Sessions belong to one staff
// member; every query that touches one names the staff member or the session.

/**
 * The tenant of the account with this username, if any. Usernames are unique
 * across tenants (#13, decision 3a), so sign-in finds the tenant first and
 * does the rest of its work in it. Row-level security hides every tenant's
 * rows until then, so this goes through a database function that sees only
 * this (migration 070).
 */
export async function tenantOfUsername(q: Queryable, username: string): Promise<number | undefined> {
  const { rows } = await sql<{ tenant_id: number | null }>`SELECT auth_tenant_of_username(${username}) AS tenant_id`.execute(q);
  return rows[0].tenant_id ?? undefined;
}

/** The tenant of the session a refresh token belongs to, if any (a database function, as above). */
export async function tenantOfRefreshToken(q: Queryable, tokenHash: string): Promise<number | undefined> {
  const { rows } = await sql<{ tenant_id: number | null }>`SELECT auth_tenant_of_refresh_token(${tokenHash}) AS tenant_id`.execute(q);
  return rows[0].tenant_id ?? undefined;
}

export async function findCredentials(q: Queryable, username: string): Promise<StaffCredentials | undefined> {
  const row = await q
    .selectFrom('staff')
    .select(['id', 'password_hash', 'is_active', 'is_all_branches', 'must_change_password', 'locked_until'])
    // Usernames are unique ignoring case (migration 064); the index on lower(username) serves this.
    .where(sql`lower(username)`, '=', username.toLowerCase())
    .executeTakeFirst();
  return (
    row && {
      staffId: row.id,
      passwordHash: row.password_hash,
      isActive: row.is_active,
      isAllBranches: row.is_all_branches,
      mustChangePassword: row.must_change_password,
      lockedUntil: row.locked_until,
    }
  );
}

export async function findPasswordHash(q: Queryable, staffId: number): Promise<string | undefined> {
  const row = await q.selectFrom('staff').select('password_hash').where('id', '=', staffId).executeTakeFirst();
  return row?.password_hash;
}

/**
 * Counts a failed sign-in in one statement, so parallel guesses are all
 * counted. A lock that has run out starts the count again. Returns the new
 * count, or undefined if the account is locked right now (not counted).
 */
export async function countFailedSignIn(q: Queryable, staffId: number): Promise<number | undefined> {
  const row = await q
    .updateTable('staff')
    .set({
      failed_login_attempts: sql<number>`CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_login_attempts + 1 END`,
      locked_until: null,
    })
    .where('id', '=', staffId)
    .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<=', sql<Date>`now()`)]))
    .returning('failed_login_attempts')
    .executeTakeFirst();
  return row?.failed_login_attempts;
}

/** Locks the account unless it already is; true if this call locked it. */
export async function lock(q: Queryable, staffId: number, minutes: number): Promise<boolean> {
  const row = await q
    .updateTable('staff')
    .set({ locked_until: sql<Date>`now() + make_interval(mins => ${minutes})` })
    .where('id', '=', staffId)
    .where('locked_until', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

export async function recordSignIn(q: Queryable, staffId: number): Promise<void> {
  await q
    .updateTable('staff')
    .set({ failed_login_attempts: 0, locked_until: null, last_login_at: sql<Date>`now()` })
    .where('id', '=', staffId)
    .execute();
}

export async function setPassword(q: Queryable, staffId: number, passwordHash: string): Promise<void> {
  await q
    .updateTable('staff')
    .set({ password_hash: passwordHash, must_change_password: false, password_changed_at: sql<Date>`now()` })
    .where('id', '=', staffId)
    .execute();
}

/** Every role the staff member holds, in assignment order. */
export async function assignments(q: Queryable, staffId: number): Promise<RoleAssignment[]> {
  const rows = await q
    .selectFrom('staff_branch_roles')
    .select(['branch_id', 'role'])
    .where('staff_id', '=', staffId)
    .orderBy('id')
    .execute();
  return rows.map((r) => ({ branchId: r.branch_id, role: r.role }));
}

export async function findBranch(q: Queryable, branchId: number): Promise<{ isActive: boolean } | undefined> {
  const row = await q.selectFrom('branches').select('is_active').where('id', '=', branchId).executeTakeFirst();
  return row && { isActive: row.is_active };
}

export async function openBranches(q: Queryable): Promise<Array<{ id: number; name: string }>> {
  return q.selectFrom('branches').select(['id', 'name']).where('is_active', '=', true).orderBy('name').execute();
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function createSession(q: Queryable, s: { staffId: number; branchId: number; expiresAt: Date }): Promise<string> {
  const row = await q
    .insertInto('staff_sessions')
    .values({ staff_id: s.staffId, branch_id: s.branchId, expires_at: s.expiresAt })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function setSessionBranch(q: Queryable, sessionId: string, staffId: number, branchId: number): Promise<void> {
  await q
    .updateTable('staff_sessions')
    .set({ branch_id: branchId })
    .where('id', '=', sessionId)
    .where('staff_id', '=', staffId)
    .execute();
}

export async function revokeSession(q: Queryable, sessionId: string, staffId: number, reason: RevokeReason): Promise<void> {
  await q
    .updateTable('staff_sessions')
    .set({ revoked_at: sql<Date>`now()`, revoked_reason: reason })
    .where('id', '=', sessionId)
    .where('staff_id', '=', staffId)
    .where('revoked_at', 'is', null)
    .execute();
}

/** Ends the staff member's open sessions, except `keep` (the one making the change). */
export async function revokeSessionsOf(q: Queryable, staffId: number, reason: RevokeReason, keep?: string): Promise<void> {
  let query = q
    .updateTable('staff_sessions')
    .set({ revoked_at: sql<Date>`now()`, revoked_reason: reason })
    .where('staff_id', '=', staffId)
    .where('revoked_at', 'is', null);
  if (keep) query = query.where('id', '!=', keep);
  await query.execute();
}

/** Everything authenticate() checks, in one round trip. */
export async function sessionState(q: Queryable, staffId: number, sessionId: string): Promise<SessionState | undefined> {
  const row = await q
    .selectFrom('staff as s')
    .leftJoin('staff_sessions as ss', (j) => j.onRef('ss.staff_id', '=', 's.id').on('ss.id', '=', sessionId))
    .select([
      's.tenant_id',
      's.is_active',
      's.is_all_branches',
      's.must_change_password',
      sql<boolean>`ss.id IS NOT NULL AND ss.revoked_at IS NULL AND ss.expires_at > now()`.as('session_live'),
      sql<RoleAssignment[]>`COALESCE((
        SELECT json_agg(json_build_object('branchId', r.branch_id, 'role', r.role) ORDER BY r.id)
        FROM staff_branch_roles r WHERE r.staff_id = s.id), '[]'::json)`.as('assignments'),
    ])
    .where('s.id', '=', staffId)
    .executeTakeFirst();
  return (
    row && {
      tenantId: row.tenant_id,
      isActive: row.is_active,
      isAllBranches: row.is_all_branches,
      mustChangePassword: row.must_change_password,
      sessionLive: row.session_live,
      assignments: row.assignments,
    }
  );
}

// ── Refresh tokens ────────────────────────────────────────────────────────────

export async function insertRefreshToken(q: Queryable, t: { sessionId: string; staffId: number; tokenHash: string }): Promise<void> {
  await q.insertInto('refresh_tokens').values({ session_id: t.sessionId, staff_id: t.staffId, token_hash: t.tokenHash }).execute();
}

/** The token with this hash, locked until the transaction ends, so two refreshes with it take turns. */
export async function findRefreshToken(q: Queryable, tokenHash: string): Promise<RefreshTokenRecord | undefined> {
  const row = await q
    .selectFrom('refresh_tokens as rt')
    .innerJoin('staff_sessions as ss', 'ss.id', 'rt.session_id')
    .innerJoin('staff as s', 's.id', 'ss.staff_id')
    .select([
      'rt.id',
      'rt.used_at',
      'ss.id as session_id',
      'ss.staff_id',
      'ss.branch_id',
      'ss.expires_at',
      'ss.revoked_at',
      's.is_active',
      's.is_all_branches',
      's.must_change_password',
      sql<Date>`now()`.as('now'),
    ])
    .where('rt.token_hash', '=', tokenHash)
    .forUpdate('rt')
    .executeTakeFirst();
  return (
    row && {
      tokenId: String(row.id),
      usedAt: row.used_at,
      sessionId: row.session_id,
      staffId: row.staff_id,
      branchId: row.branch_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      staffActive: row.is_active,
      isAllBranches: row.is_all_branches,
      mustChangePassword: row.must_change_password,
      now: row.now,
    }
  );
}

export async function markRefreshTokenUsed(q: Queryable, tokenId: string): Promise<void> {
  await q.updateTable('refresh_tokens').set({ used_at: sql<Date>`now()` }).where('id', '=', tokenId).execute();
}

// ── Profile ───────────────────────────────────────────────────────────────────

export async function profile(q: Queryable, staffId: number) {
  return q
    .selectFrom('staff as s')
    .select([
      's.id',
      's.username',
      's.full_name',
      's.is_active',
      's.created_at',
      's.must_change_password',
      's.last_login_at',
      's.password_changed_at',
      's.locked_until',
      's.is_all_branches',
      sql<Array<{ branchId: number; branchName: string | null; role: string }>>`COALESCE((
        SELECT json_agg(json_build_object('branchId', r.branch_id, 'branchName', b.name, 'role', r.role) ORDER BY r.id)
        FROM staff_branch_roles r LEFT JOIN branches b ON b.id = r.branch_id
        WHERE r.staff_id = s.id), '[]'::json)`.as('roles'),
    ])
    .where('s.id', '=', staffId)
    .executeTakeFirst();
}

/** The locations the staff member is limited to in the branch; none means all of them. */
export async function assignedLocations(q: Queryable, staffId: number, branchId: number) {
  return q
    .selectFrom('staff_locations as sl')
    .innerJoin('locations as l', 'l.id', 'sl.location_id')
    .select(['l.id', 'l.name', 'l.is_default_fulfillment'])
    .where('sl.staff_id', '=', staffId)
    .where('l.branch_id', '=', branchId)
    .orderBy('l.is_default_fulfillment', 'desc')
    .orderBy('l.name')
    .execute();
}
