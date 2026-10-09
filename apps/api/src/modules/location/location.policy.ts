import { BranchAccessError, ConflictError, ForbiddenError } from '../../lib/errors.js';
import type { Actor, LocationDependency } from './location.types.js';

/**
 * Location rules as pure functions (A5): no I/O, so they are unit-tested
 * without a database (__tests__/location.policy.test.ts).
 */

/** Roles that manage a branch's locations, so are never limited to some of them. */
const FULL_ACCESS_ROLES = ['Super_Admin', 'Admin', 'Manager'];

export function hasFullLocationAccess(role: string): boolean {
  return FULL_ACCESS_ROLES.includes(role);
}

/** The branches whose staff restrictions the actor may change; null means every branch. */
export function manageableBranches(actor: Actor): number[] | null {
  return actor.allBranches ? null : [actor.branchId];
}

function canManage(manageable: number[] | null, branchId: number): boolean {
  return manageable === null || manageable.includes(branchId);
}

/** Staff limited to one branch manage only staff who work in that branch. */
export function checkCanManageStaff(actor: Actor, targetBranches: number[]): void {
  const manageable = manageableBranches(actor);
  if (manageable !== null && !targetBranches.some((b) => canManage(manageable, b))) {
    throw new BranchAccessError(targetBranches[0] ?? actor.branchId);
  }
}

/**
 * Checks a replacement set of a staff member's locations:
 * - each location must exist, in a branch the staff member works in;
 * - in branches the actor cannot manage, the set must match the current one
 *   (the staff page sends every branch's locations back unchanged).
 */
export function checkStaffLocationChange(
  actor: Actor,
  requested: number[],
  locationBranch: Map<number, number>,
  targetBranches: number[],
  current: Array<{ locationId: number; branchId: number }>,
): void {
  for (const id of requested) {
    const branchId = locationBranch.get(id);
    if (branchId === undefined || !targetBranches.includes(branchId)) {
      throw new ForbiddenError('One or more locations do not belong to the staff member\'s assigned branches');
    }
  }

  const manageable = manageableBranches(actor);
  if (manageable === null) return;
  const before = new Map(current.map((a) => [a.locationId, a.branchId]));
  const after = new Map(requested.map((id) => [id, locationBranch.get(id)!]));
  for (const [id, branchId] of [...after, ...before]) {
    if (canManage(manageable, branchId)) continue;
    if (before.has(id) !== after.has(id)) throw new BranchAccessError(branchId);
  }
}

/** Throws 409 DEPENDENCY_CONFLICT unless nothing keeps the location from being deleted. */
export function checkDeletable(stockLines: number, history: LocationDependency[]): void {
  if (stockLines > 0) {
    throw new ConflictError('DEPENDENCY_CONFLICT', 'Cannot delete location: inventory items exist', {
      blockingDependencies: [{ type: 'inventory', count: stockLines }],
    });
  }
  if (history.length > 0) {
    // These tables reference the location without ON DELETE, so the database
    // would refuse the delete whatever the rows' status.
    throw new ConflictError('DEPENDENCY_CONFLICT', 'Cannot delete location: it has transaction history', {
      blockingDependencies: history,
    });
  }
}
