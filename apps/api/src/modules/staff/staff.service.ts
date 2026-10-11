import bcrypt from 'bcrypt';
import { kysely } from '../../db/kysely.js';
import { isUniqueViolation } from '../../db/errors.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { BusinessError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { assignments, revokeSessionsOf } from '../auth/auth.repository.js';
import * as policy from './staff.policy.js';
import * as repo from './staff.repository.js';
import type { Actor, NewStaff, RoleAssignment, StaffRecord } from './staff.types.js';

// Staff administration (#21, auth part 2). Every change checks, in its
// transaction, that the actor may manage the account as it is now, and is
// audited with the actor.

const BCRYPT_ROUNDS = 12;

type ActorContext = Omit<Actor, 'assignments'>;

async function actorOf(ctx: ActorContext): Promise<Actor> {
  return { ...ctx, assignments: await assignments(kysely, ctx.staffId) };
}

const rolesOf = (s: StaffRecord): RoleAssignment[] => s.roles.map((r) => ({ branchId: r.branchId, role: r.role }));

/** The account, if the actor may see it; otherwise 404, as if it did not exist. */
async function visibleStaff(q: Queryable, actor: Actor, id: number, opts: { forUpdate?: boolean } = {}): Promise<StaffRecord> {
  const staff = await repo.find(q, id, opts);
  if (!staff || !policy.canView(actor, staff.id, rolesOf(staff))) throw new NotFoundError('Staff');
  return staff;
}

/** The account, locked, if the actor may manage it. */
async function manageable(tx: Queryable, actor: Actor, id: number): Promise<StaffRecord> {
  const staff = await visibleStaff(tx, actor, id, { forUpdate: true });
  policy.checkCanManage(actor, staff.id, rolesOf(staff));
  return staff;
}

function audit(tx: Queryable, actor: Actor, action: string, entityType: string, staffId: number, meta: Record<string, unknown>) {
  return insertAuditEntry(tx, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType,
    entityId: staffId,
    meta,
  });
}

async function checkBranchesExist(tx: Queryable, roles: RoleAssignment[]): Promise<void> {
  const wanted = [...new Set(roles.map((r) => r.branchId))];
  const found = await repo.existingBranches(tx, wanted);
  const missing = wanted.find((b) => !found.includes(b));
  if (missing !== undefined) throw new NotFoundError(`Branch ${missing}`);
}

/** Ends the role or the account of the last active Super_Admin? Refused. */
async function checkKeepsSuperAdmin(tx: Queryable, staffId: number, code: string, message: string): Promise<void> {
  if (!policy.keepsASuperAdmin(await repo.lockOtherActiveSuperAdmins(tx, staffId))) {
    throw new BusinessError(code, message);
  }
}

// ── Reading ───────────────────────────────────────────────────────────────────

export async function list(ctx: ActorContext, page: { limit: number; offset: number }) {
  const actor = await actorOf(ctx);
  const { items, total } = await repo.list(kysely, policy.visibility(actor), page);
  return { items: items.map((s) => ({ record: s, canManage: policy.canManage(actor, s.id, rolesOf(s)) })), total };
}

export async function getById(ctx: ActorContext, id: number) {
  const actor = await actorOf(ctx);
  const staff = await visibleStaff(kysely, actor, id);
  return { record: staff, canManage: policy.canManage(actor, staff.id, rolesOf(staff)) };
}

// ── Changing ──────────────────────────────────────────────────────────────────

/** Creates the account with its roles and all-branch access, in one step (owner decision 5a). */
export async function create(ctx: ActorContext, input: NewStaff): Promise<number> {
  const actor = await actorOf(ctx);
  policy.checkRoleChanges(actor, input.roles);
  if (input.isAllBranches) policy.checkCanSetAllBranches(actor);
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  try {
    return await withTransaction({}, async (tx) => {
      await checkBranchesExist(tx, input.roles);
      const id = await repo.insert(tx, { username: input.username, passwordHash, fullName: input.fullName, isAllBranches: input.isAllBranches });
      await repo.addRoles(tx, id, input.roles);
      await audit(tx, actor, 'CREATE', 'staff', id, { username: input.username, roles: input.roles, isAllBranches: input.isAllBranches });
      return id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('DUPLICATE_USERNAME', `Username '${input.username}' already exists`);
    throw err;
  }
}

export async function updateName(ctx: ActorContext, id: number, fullName: string): Promise<void> {
  const actor = await actorOf(ctx);
  await withTransaction({}, async (tx) => {
    const staff = await manageable(tx, actor, id);
    await repo.setFullName(tx, id, fullName);
    await audit(tx, actor, 'UPDATE', 'staff', id, { fullName: { from: staff.fullName, to: fullName } });
  });
}

/**
 * Sets the staff member's roles. Only the changes are applied, and each must
 * be a role the actor may grant in a branch they manage, so roles elsewhere
 * stay as they are (was: every role in every branch was replaced).
 */
export async function setRoles(ctx: ActorContext, id: number, desired: RoleAssignment[]): Promise<void> {
  const actor = await actorOf(ctx);
  await withTransaction({}, async (tx) => {
    const staff = await manageable(tx, actor, id);
    const { added, removed } = policy.roleChanges(rolesOf(staff), desired);
    if (added.length === 0 && removed.length === 0) return;
    policy.checkRoleChanges(actor, [...added, ...removed]);
    await checkBranchesExist(tx, added);

    const losesSuperAdmin =
      removed.some((r) => r.role === 'Super_Admin') && !desired.some((r) => r.role === 'Super_Admin');
    if (losesSuperAdmin && staff.isActive) {
      await checkKeepsSuperAdmin(tx, id, 'CANNOT_REMOVE_LAST_SUPER_ADMIN', 'The last active Super_Admin keeps the role. Make someone else Super_Admin first.');
    }

    await repo.removeRoles(tx, id, removed);
    await repo.addRoles(tx, id, added);
    await audit(tx, actor, 'UPDATE', 'staff_roles', id, { added, removed });
  });
}

export async function setAllBranches(ctx: ActorContext, id: number, isAllBranches: boolean): Promise<void> {
  const actor = await actorOf(ctx);
  policy.checkCanSetAllBranches(actor);
  await withTransaction({}, async (tx) => {
    const staff = await manageable(tx, actor, id);
    if (staff.isAllBranches === isAllBranches) return;
    await repo.setAllBranches(tx, id, isAllBranches);
    await audit(tx, actor, 'UPDATE', 'staff', id, { action: 'set_all_branches', isAllBranches });
  });
}

/** Deactivates the account and ends its sessions; the roles are kept for a reactivation. */
export async function deactivate(ctx: ActorContext, id: number): Promise<void> {
  if (id === ctx.staffId) throw new BusinessError('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account.');
  const actor = await actorOf(ctx);
  await withTransaction({}, async (tx) => {
    const staff = await manageable(tx, actor, id);
    if (!staff.isActive) return;
    if (staff.roles.some((r) => r.role === 'Super_Admin')) {
      await checkKeepsSuperAdmin(tx, id, 'CANNOT_DEACTIVATE_LAST_SUPER_ADMIN', 'Cannot deactivate the last active Super_Admin. Create another Super_Admin first.');
    }
    await repo.setActive(tx, id, false);
    await revokeSessionsOf(tx, id, 'deactivated');
    await audit(tx, actor, 'INACTIVATE', 'staff', id, { username: staff.username });
    await insertOutboxEvent(tx, 'auth.staff_deactivated', { username: staff.username, branchId: null });
  });
}

export async function reactivate(ctx: ActorContext, id: number): Promise<void> {
  const actor = await actorOf(ctx);
  await withTransaction({}, async (tx) => {
    const staff = await manageable(tx, actor, id);
    if (staff.isActive) return;
    await repo.setActive(tx, id, true);
    await audit(tx, actor, 'ACTIVATE', 'staff', id, { username: staff.username });
  });
}

/** Sets a temporary password, to change at the next sign-in, and ends the account's sessions. */
export async function resetPassword(ctx: ActorContext, id: number, temporaryPassword: string): Promise<void> {
  const actor = await actorOf(ctx);
  const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS);
  await withTransaction({}, async (tx) => {
    const staff = await manageable(tx, actor, id);
    const admin = await repo.find(tx, actor.staffId);
    await repo.resetPassword(tx, id, passwordHash);
    await revokeSessionsOf(tx, id, 'password_reset');
    await audit(tx, actor, 'UPDATE', 'staff', id, { action: 'admin_password_reset', mustChangePassword: true });
    await insertOutboxEvent(tx, 'auth.password_reset', { username: staff.username, adminName: admin?.username ?? String(actor.staffId), branchId: null });
  });
}

export async function unlock(ctx: ActorContext, id: number): Promise<void> {
  const actor = await actorOf(ctx);
  await withTransaction({}, async (tx) => {
    await manageable(tx, actor, id);
    await repo.unlock(tx, id);
    await audit(tx, actor, 'UPDATE', 'staff', id, { action: 'account_unlocked' });
  });
}

