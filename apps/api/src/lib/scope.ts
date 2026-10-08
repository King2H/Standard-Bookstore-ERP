import type { Request } from 'express';
import { BranchAccessError } from './errors.js';

/**
 * Branch scope for branch-owned data (#12). The scope comes from the access
 * token, checked by authenticate(); `?branchId=` only narrows it.
 *
 * Permissions belong to a branch: someone who is Sales in branch A and
 * Manager in branch B gets B's permissions only after switching to B. So
 * staff who hold roles in several branches still see one branch at a time,
 * the one they are signed in to. Staff with access to all branches
 * (staff.is_all_branches) may read any branch.
 */
export interface Scope {
  staffId: number;
  branchId: number;
  allBranches: boolean;
}

export function scopeOf(req: Request): Scope {
  if (!req.scope) throw new Error('scopeOf() called on a route without authenticate()');
  return req.scope;
}

// Values that never named a branch (missing, empty, "null", "0") mean "no
// branch requested", as they always have for these endpoints.
function requestedBranch(req: Request): number | undefined {
  const raw = req.query.branchId;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * The branch a request reads, from `?branchId=`:
 * - no branch requested: the session's branch;
 * - the session's branch: that branch;
 * - another branch: allowed only with access to all branches. Anyone else
 *   gets 403 BRANCH_ACCESS_DENIED and has to switch branch.
 */
export function scopedBranch(req: Request): number {
  const scope = scopeOf(req);
  const requested = requestedBranch(req) ?? scope.branchId;
  if (requested !== scope.branchId && !scope.allBranches) {
    throw new BranchAccessError(requested);
  }
  return requested;
}

/**
 * Like scopedBranch(), except that staff with access to all branches who
 * request no branch get every branch (undefined), for cross-branch views
 * such as the dashboard's "All".
 */
export function scopedBranchOrAll(req: Request): number | undefined {
  const scope = scopeOf(req);
  if (scope.allBranches && requestedBranch(req) === undefined) return undefined;
  return scopedBranch(req);
}
