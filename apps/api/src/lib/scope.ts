import type { Request } from 'express';
import { db } from '../db/index.js';
import { BranchAccessError, NotFoundError } from './errors.js';

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

/** read: GET requests; write: anything that changes the record. */
export type RecordAccess = 'read' | 'write';

/**
 * Whether the session may use a record that belongs to `branches` (usually
 * one; a purchase order also belongs to its receiving branch):
 * - in the session's branch: read and write;
 * - in another branch: read only, and only with access to all branches.
 *   Acting on it needs a switch to that branch, so the money, stock and
 *   audit entries are booked there with that branch's roles.
 * Otherwise 404, so the response does not confirm the record exists.
 */
export function checkRecordBranch(req: Request, branches: number[], access: RecordAccess, entity: string): void {
  const scope = scopeOf(req);
  if (branches.includes(scope.branchId)) return;
  if (access === 'read' && scope.allBranches) return;
  throw new NotFoundError(entity);
}

/**
 * A location named in a write request must be in the session's branch, for
 * everyone: stock and sales are booked in the branch the staff member is
 * signed in to. Null means "the branch's default location", which is.
 */
export async function assertLocationInBranch(req: Request, locationId: number | null | undefined): Promise<void> {
  if (locationId === null || locationId === undefined) return;
  const scope = scopeOf(req);
  const { rows } = await db.query<{ branch_id: number }>('SELECT branch_id FROM locations WHERE id = $1', [locationId]);
  if (!rows.length) throw new NotFoundError('Location');
  if (rows[0].branch_id !== scope.branchId) throw new BranchAccessError(rows[0].branch_id);
}

/**
 * The branch a new sale or purchase order is booked in: always the session's
 * branch. A different `requested` branch (from an old client) is refused
 * rather than silently ignored.
 */
export function bookingBranch(req: Request, requested: unknown): number {
  const scope = scopeOf(req);
  if (requested !== undefined && requested !== null && Number(requested) !== scope.branchId) {
    throw new BranchAccessError(Number(requested));
  }
  return scope.branchId;
}

/**
 * Changing a branch's setup (its locations, bank accounts) under
 * /branches/:branchId: the session's branch, or any branch with access to
 * all branches.
 */
export function checkBranchSetupAccess(req: Request, branchId: number): void {
  const scope = scopeOf(req);
  if (branchId !== scope.branchId && !scope.allBranches) throw new BranchAccessError(branchId);
}
