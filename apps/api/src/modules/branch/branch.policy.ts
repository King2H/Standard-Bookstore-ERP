import { BranchAccessError, ConflictError, ForbiddenError } from '../../lib/errors.js';
import type { Actor, BranchDependency } from './branch.types.js';

/**
 * Branch rules as pure functions (A5): no I/O, so they are unit-tested
 * without a database (__tests__/branch.policy.test.ts).
 */

/**
 * Opening, closing and deleting a branch are head-office actions: Super_Admin,
 * or Admin with access to all branches.
 */
export function checkCanOpenOrClose(actor: Actor): void {
  if (actor.role === 'Super_Admin' || (actor.role === 'Admin' && actor.allBranches)) return;
  throw new ForbiddenError('Only Super_Admin, or Admin with access to all branches, can open, close or delete branches');
}

/**
 * A branch's details (name, address, contacts, hours) are edited from that
 * branch, or by Super_Admin and staff with access to all branches. The route
 * limits the roles to Super_Admin, Admin and Manager.
 */
export function checkCanEditDetails(actor: Actor, branchId: number): void {
  if (actor.role === 'Super_Admin' || actor.allBranches || actor.branchId === branchId) return;
  throw new BranchAccessError(branchId);
}

/** Throws 409 DEPENDENCY_CONFLICT while anything still belongs to the branch. */
export function checkDeletable(dependencies: BranchDependency[]): void {
  if (dependencies.length > 0) {
    throw new ConflictError('DEPENDENCY_CONFLICT', 'Branch has blocking dependencies', {
      blockingDependencies: dependencies,
    });
  }
}
