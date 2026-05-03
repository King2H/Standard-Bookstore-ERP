import { Request, Response, NextFunction } from 'express';
import { db } from '../db/index.js';
import { ForbiddenError, ValidationError } from '../lib/errors.js';

/**
 * Validates X-Branch-Id header and confirms the authenticated staff member
 * has a role assignment for that branch (or has is_all_branches = true).
 * Attaches branchId to req.staff.
 *
 * is_all_branches support:
 * - If staff.is_all_branches = true AND X-Branch-Id is provided → use that branch
 * - If staff.is_all_branches = true AND no X-Branch-Id → allow all-branch queries
 *   (branchId stays as the JWT branchId; routes handle the all-branch case)
 */
export async function branchCtx(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const branchIdHeader = req.headers['x-branch-id'];

  if (!req.staff) {
    return next(new ForbiddenError('Authentication required'));
  }

  // Check if staff has is_all_branches flag
  let isAllBranches = false;
  try {
    const staffRow = await db.query(
      `SELECT is_all_branches FROM staff WHERE id = $1`,
      [req.staff.staffId],
    );
    isAllBranches = staffRow.rows[0]?.is_all_branches === true;
  } catch { /* non-fatal — fall through to normal branch check */ }

  // If no X-Branch-Id header
  if (!branchIdHeader) {
    if (isAllBranches) {
      // All-branch staff: allow without a specific branch (branchId from JWT is used)
      next();
      return;
    }
    return next(new ValidationError('X-Branch-Id header is required'));
  }

  const branchId = parseInt(branchIdHeader as string, 10);
  if (isNaN(branchId)) {
    return next(new ValidationError('X-Branch-Id must be a valid integer'));
  }

  // All-branch staff can access any branch without a role assignment check
  if (isAllBranches) {
    req.staff.branchId = branchId;
    next();
    return;
  }

  try {
    // Verify staff has a role assignment for this branch
    const result = await db.query(
      `SELECT role FROM staff_branch_roles WHERE staff_id = $1 AND branch_id = $2 ORDER BY id ASC LIMIT 1`,
      [req.staff.staffId, branchId],
    );

    if (result.rows.length === 0) {
      return next(
        new ForbiddenError(`Staff member has no role assignment for branch ${branchId}`),
      );
    }

    // Update branchId in staff context (JWT may carry a different branch)
    req.staff.branchId = branchId;
    req.staff.role = result.rows[0].role;
    next();
  } catch (err) {
    next(err);
  }
}
