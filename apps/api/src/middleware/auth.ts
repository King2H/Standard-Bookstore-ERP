import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@bms/shared';
import { AuthError, BranchAccessError, PasswordChangeRequiredError, ServiceUnavailableError } from '../lib/errors.js';
import { db } from '../db/index.js';

interface JwtPayload {
  staffId: number;
  role: Role;
  roles?: string[];    // all roles for the active branch (added in refactor)
  branchId: number;
  permissions?: string[];
}

/**
 * Checks the access token and, on every request, the staff row behind it:
 * the account is active, still holds a role in the token's branch (#12), and
 * has no pending password change (#38). Endpoints the staff member needs in
 * order to change the password use authenticateAllowingPasswordChange.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  return verify(req, res, next, { allowPendingPasswordChange: false });
}

/**
 * authenticate() for the few endpoints usable while a password change is
 * pending: reading the profile, changing the password, the branch list and
 * logging out.
 */
export function authenticateAllowingPasswordChange(req: Request, res: Response, next: NextFunction): Promise<void> {
  return verify(req, res, next, { allowPendingPasswordChange: true });
}

async function verify(
  req: Request,
  _res: Response,
  next: NextFunction,
  opts: { allowPendingPasswordChange: boolean },
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AuthError('MISSING_TOKEN', 'Authorization header required'));
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    return next(new AuthError('SERVER_ERROR', 'JWT secret not configured'));
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, secret) as JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AuthError('TOKEN_EXPIRED', 'Access token has expired'));
    }
    return next(new AuthError('INVALID_TOKEN', 'Invalid access token'));
  }

  // F-016: Check staff is still active on every request.
  // Fails closed: a DB error here must NOT grant access. A deactivated staff
  // member (or a stolen token for one) must not slip through during a
  // transient DB issue — availability of one request is not worth an
  // unauthorized action against inventory/payments/receivables.
  // The same query loads the branch scope (#12): the token's branch counts
  // only while the staff member still holds a role there, or has access to
  // all branches, so a removed assignment stops working at once instead of
  // when the token expires.
  let allBranches: boolean;
  try {
    const result = await db.query(
      `SELECT s.is_active, s.is_all_branches, s.must_change_password,
              EXISTS (SELECT 1 FROM staff_branch_roles r WHERE r.staff_id = s.id AND r.branch_id = $2) AS has_branch_role
       FROM staff s WHERE s.id = $1`,
      [payload.staffId, payload.branchId],
    );
    if (!result.rows.length || !result.rows[0].is_active) {
      return next(new AuthError('ACCOUNT_INACTIVE', 'Your account has been deactivated'));
    }
    allBranches = result.rows[0].is_all_branches === true;
    if (!allBranches && !result.rows[0].has_branch_role) {
      return next(new BranchAccessError(payload.branchId));
    }
    // Read from the database, not the token, so an admin reset applies to
    // sessions that are already open, and a change applies at once.
    if (result.rows[0].must_change_password === true && !opts.allowPendingPasswordChange) {
      return next(new PasswordChangeRequiredError());
    }
  } catch {
    return next(new ServiceUnavailableError('Unable to verify account status — please retry'));
  }

  req.staff = {
    staffId: payload.staffId,
    role: payload.role,
    roles: payload.roles ?? [payload.role],
    branchId: payload.branchId,
    permissions: payload.permissions,
  };
  req.scope = { staffId: payload.staffId, branchId: payload.branchId, allBranches };
  next();
}
