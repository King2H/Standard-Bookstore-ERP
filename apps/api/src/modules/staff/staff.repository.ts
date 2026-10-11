import { sql, type ExpressionBuilder } from 'kysely';
import type { DB } from '../../db/types.generated.js';
import type { Queryable } from '../../db/tx.js';
import type { RoleAssignment, StaffRecord, Visibility } from './staff.types.js';

// Staff accounts and their roles (#21, auth part 2). Lists take the visibility
// the policy worked out; single accounts are checked by the service.

type Page = { limit: number; offset: number };

function selectStaff(q: Queryable) {
  return q
    .selectFrom('staff as s')
    .select([
      's.id',
      's.username',
      's.full_name',
      's.is_active',
      's.created_at',
      's.must_change_password',
      's.locked_until',
      's.failed_login_attempts',
      's.last_login_at',
      's.password_changed_at',
      's.is_all_branches',
      sql<Array<{ branchId: number; branchName: string | null; role: string }>>`COALESCE((
        SELECT json_agg(json_build_object('branchId', r.branch_id, 'branchName', b.name, 'role', r.role) ORDER BY r.id)
        FROM staff_branch_roles r LEFT JOIN branches b ON b.id = r.branch_id
        WHERE r.staff_id = s.id), '[]'::json)`.as('roles'),
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof selectStaff>['executeTakeFirstOrThrow']>>;

function toRecord(r: Row): StaffRecord {
  return {
    id: r.id,
    username: r.username,
    fullName: r.full_name,
    isActive: r.is_active,
    createdAt: r.created_at,
    mustChangePassword: r.must_change_password,
    lockedUntil: r.locked_until,
    failedLoginAttempts: r.failed_login_attempts,
    lastLoginAt: r.last_login_at,
    passwordChangedAt: r.password_changed_at,
    isAllBranches: r.is_all_branches,
    roles: r.roles,
  };
}

function visible(v: Extract<Visibility, { all: false }>) {
  return (eb: ExpressionBuilder<DB & { s: DB['staff'] }, 's'>) => {
    const hasRoleIn = v.branchIds.length
      ? eb.exists(
          eb.selectFrom('staff_branch_roles as r').select('r.staff_id').whereRef('r.staff_id', '=', 's.id').where('r.branch_id', 'in', v.branchIds),
        )
      : sql<boolean>`false`;
    if (!v.includeRoleless) return hasRoleIn;
    return eb.or([hasRoleIn, eb.not(eb.exists(eb.selectFrom('staff_branch_roles as r').select('r.staff_id').whereRef('r.staff_id', '=', 's.id')))]);
  };
}

export async function list(q: Queryable, v: Visibility, page: Page): Promise<{ items: StaffRecord[]; total: number }> {
  let query = selectStaff(q);
  if (!v.all) query = query.where(visible(v));
  const [rows, count] = await Promise.all([
    query.orderBy('s.username').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toRecord), total: Number(count.count) };
}

/** One account; with `forUpdate`, locked until the transaction ends. */
export async function find(q: Queryable, id: number, opts: { forUpdate?: boolean } = {}): Promise<StaffRecord | undefined> {
  let query = selectStaff(q).where('s.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('s');
  const row = await query.executeTakeFirst();
  return row && toRecord(row);
}

export async function insert(
  q: Queryable,
  s: { username: string; passwordHash: string; fullName: string; isAllBranches: boolean },
): Promise<number> {
  const row = await q
    .insertInto('staff')
    .values({ username: s.username, password_hash: s.passwordHash, full_name: s.fullName, is_active: true, is_all_branches: s.isAllBranches })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function addRoles(q: Queryable, staffId: number, roles: RoleAssignment[]): Promise<void> {
  if (roles.length === 0) return;
  await q
    .insertInto('staff_branch_roles')
    .values(roles.map((r) => ({ staff_id: staffId, branch_id: r.branchId, role: r.role })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function removeRoles(q: Queryable, staffId: number, roles: RoleAssignment[]): Promise<void> {
  for (const r of roles) {
    await q
      .deleteFrom('staff_branch_roles')
      .where('staff_id', '=', staffId)
      .where('branch_id', '=', r.branchId)
      .where('role', '=', r.role)
      .execute();
  }
}

/** The ids among `branchIds` that exist. */
export async function existingBranches(q: Queryable, branchIds: number[]): Promise<number[]> {
  if (branchIds.length === 0) return [];
  const rows = await q.selectFrom('branches').select('id').where('id', 'in', branchIds).execute();
  return rows.map((r) => r.id);
}

/**
 * Locks the active Super_Admins other than `staffId` and counts them, so two
 * changes at once cannot both take away the last one.
 */
export async function lockOtherActiveSuperAdmins(q: Queryable, staffId: number): Promise<number> {
  const rows = await q
    .selectFrom('staff as s')
    .select('s.id')
    .where('s.is_active', '=', true)
    .where('s.id', '!=', staffId)
    .where((eb) =>
      eb.exists(eb.selectFrom('staff_branch_roles as r').select('r.staff_id').whereRef('r.staff_id', '=', 's.id').where('r.role', '=', 'Super_Admin')),
    )
    .forUpdate('s')
    .execute();
  return rows.length;
}

export async function setFullName(q: Queryable, id: number, fullName: string): Promise<void> {
  await q.updateTable('staff').set({ full_name: fullName }).where('id', '=', id).execute();
}

export async function setActive(q: Queryable, id: number, isActive: boolean): Promise<void> {
  await q.updateTable('staff').set({ is_active: isActive }).where('id', '=', id).execute();
}

export async function setAllBranches(q: Queryable, id: number, isAllBranches: boolean): Promise<void> {
  await q.updateTable('staff').set({ is_all_branches: isAllBranches }).where('id', '=', id).execute();
}

/** A temporary password the staff member must change at the next sign-in; also lifts a lockout. */
export async function resetPassword(q: Queryable, id: number, passwordHash: string): Promise<void> {
  await q
    .updateTable('staff')
    .set({
      password_hash: passwordHash,
      must_change_password: true,
      failed_login_attempts: 0,
      locked_until: null,
      password_changed_at: sql<Date>`now()`,
    })
    .where('id', '=', id)
    .execute();
}

export async function unlock(q: Queryable, id: number): Promise<void> {
  await q.updateTable('staff').set({ failed_login_attempts: 0, locked_until: null }).where('id', '=', id).execute();
}
