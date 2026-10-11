import { grantableRoles, rankOf } from '@bms/shared';
import { BusinessError, ForbiddenError } from '../../lib/errors.js';
import type { Actor, RoleAssignment, Visibility } from './staff.types.js';

/**
 * Who administers which staff (#21, auth part 2). Pure functions; the service
 * applies them. Owner decisions:
 * - 1a: Super_Admin administers everyone; an Admin with access to all branches
 *   everyone below them; another Admin the staff whose roles are all in
 *   branches where they are Admin; a Manager the roles in their session branch.
 * - 2a: only people ranked strictly below you, never yourself; roles granted
 *   are below your own, except that a Super_Admin grants any role. Super_Admins
 *   administer each other, so one can always act on another.
 */

const TOP = 3;
const ADMIN = 2;

/** The branches whose roles the actor may change: 'all', or a list. */
export function reach(actor: Actor): 'all' | number[] {
  if (actor.roles.includes('Super_Admin')) return 'all';
  if (actor.roles.includes('Admin')) {
    if (actor.isAllBranches) return 'all';
    return [...new Set(actor.assignments.filter((a) => a.role === 'Admin').map((a) => a.branchId))];
  }
  if (actor.roles.includes('Manager')) return [actor.branchId];
  return [];
}

function inReach(r: 'all' | number[], branchId: number): boolean {
  return r === 'all' || r.includes(branchId);
}

/** The staff a list shows. Admins also see accounts without roles, to give them their first. */
export function visibility(actor: Actor): Visibility {
  const r = reach(actor);
  if (r === 'all') return { all: true };
  return { all: false, branchIds: r, includeRoleless: rankOf(actor.roles) >= ADMIN };
}

export function canView(actor: Actor, targetId: number, target: RoleAssignment[]): boolean {
  if (targetId === actor.staffId) return true;
  const v = visibility(actor);
  if (v.all) return true;
  if (target.length === 0) return v.includeRoleless;
  return target.some((a) => v.branchIds.includes(a.branchId));
}

/** Whether the actor may change this staff member's account. */
export function canManage(actor: Actor, targetId: number, target: RoleAssignment[]): boolean {
  if (targetId === actor.staffId) return false;
  const actorRank = rankOf(actor.roles);
  const targetRank = rankOf(target.map((a) => a.role));
  if (!(actorRank > targetRank || (actorRank === TOP && targetRank === TOP))) return false;

  const r = reach(actor);
  if (r === 'all') return true;
  if (actorRank >= ADMIN) return target.every((a) => r.includes(a.branchId));
  return target.some((a) => r.includes(a.branchId));
}

export function checkCanManage(actor: Actor, targetId: number, target: RoleAssignment[]): void {
  if (targetId === actor.staffId) {
    throw new BusinessError('CANNOT_MANAGE_SELF', 'Use your profile to change your own account');
  }
  if (!canManage(actor, targetId, target)) {
    throw new ForbiddenError('You cannot manage this staff member');
  }
}

const key = (a: RoleAssignment) => `${a.branchId}:${a.role}`;

/** What a role edit adds and removes. */
export function roleChanges(current: RoleAssignment[], desired: RoleAssignment[]): { added: RoleAssignment[]; removed: RoleAssignment[] } {
  const now = new Set(current.map(key));
  const next = new Map(desired.map((a) => [key(a), a]));
  return {
    added: [...next.values()].filter((a) => !now.has(key(a))),
    removed: current.filter((a) => !next.has(key(a))),
  };
}

/** Each role given or taken must be one the actor may grant, in a branch they manage. */
export function checkRoleChanges(actor: Actor, changes: RoleAssignment[]): void {
  const r = reach(actor);
  const grantable = grantableRoles(actor.roles);
  for (const c of changes) {
    if (!inReach(r, c.branchId)) {
      throw new ForbiddenError(`You cannot change roles in branch ${c.branchId}`);
    }
    if (!grantable.includes(c.role as (typeof grantable)[number])) {
      throw new ForbiddenError(`You cannot grant or remove the ${c.role} role`);
    }
  }
}

/** All-branch access widens someone's reach to the whole company: Super_Admin only (owner decision 3a). */
export function checkCanSetAllBranches(actor: Actor): void {
  if (!actor.roles.includes('Super_Admin')) {
    throw new ForbiddenError('Only a Super_Admin grants or removes access to all branches');
  }
}

/** The last active Super_Admin keeps the role and the account. */
export function keepsASuperAdmin(otherActiveSuperAdmins: number): boolean {
  return otherActiveSuperAdmins > 0;
}
