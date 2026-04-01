import { Request, Response, NextFunction } from 'express';
import { db } from '../db/index.js';
import { ForbiddenError, ValidationError } from '../lib/errors.js';

/**
 * Validates X-Branch-Id header and confirms the authenticated staff member
 * has a role assignment for that branch. Attaches branchId to req.staff.
 */
export async function branchCtx(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const branchIdHeader = req.headers['x-branch-id'];

  if (!branchIdHeader) {
    return next(new ValidationError('X-Branch-Id header is required'));
  }

  const branchId = parseInt(branchIdHeader as string, 10);
  if (isNaN(branchId)) {
    return next(new ValidationError('X-Branch-Id must be a valid integer'));
  }

  if (!req.staff) {
    return next(new ForbiddenError('Authentication required'));
  }

  try {
    // Verify staff has a role assignment for this branch
    const result = await db.query(
      `SELECT role FROM staff_branch_roles WHERE staff_id = $1 AND branch_id = $2`,
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
