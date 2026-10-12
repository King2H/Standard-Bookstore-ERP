import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@bms/shared';
import { runInTenant } from '../db/tenantContext.js';
import { AuthError, BranchAccessError, PasswordChangeRequiredError, ServiceUnavailableError } from '../lib/errors.js';
import { getPermissionsForRoles } from '../lib/permissions.js';
import { effectiveRoles } from '../modules/auth/auth.policy.js';
import { sessionState } from '../modules/auth/auth.service.js';
import { verifyAccessToken } from '../modules/auth/auth.tokens.js';
import type { SessionState } from '../modules/auth/auth.types.js';

/**
 * Checks the access token and, on every request, the session and staff row
 * behind it: the session is open, the account is active, holds a role in the
 * token's branch (#12), and has no pending password change (#38). Endpoints the staff member needs in
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

  let claims: ReturnType<typeof verifyAccessToken>;
  try {
    claims = verifyAccessToken(authHeader.slice(7));
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AuthError('TOKEN_EXPIRED', 'Access token has expired'));
    }
    return next(new AuthError('INVALID_TOKEN', 'Invalid access token'));
  }
  const { sid, staffId, branchId, tenantId } = claims;
  if (typeof sid !== 'string' || typeof staffId !== 'number' || typeof branchId !== 'number' || typeof tenantId !== 'number') {
    return next(new AuthError('INVALID_TOKEN', 'Invalid access token'));
  }

  // Read on every request, never taken from the token, so a change applies
  // at once (owner decision 5a): the account is active (F-016), the session
  // has not ended (logout, password change, admin reset, deactivation), the
  // roles are the ones held now in the token's branch (#12), and no password
  // change is pending (#38). Fails closed: a database error must not grant
  // access.
  //
  // The session is looked up in the token's tenant (#13, owner decision 2a):
  // the server signed that claim, and row-level security shows only that
  // tenant's rows, so a token whose tenant does not hold its session finds
  // nothing and is refused.
  let state: SessionState | undefined;
  try {
    state = await runInTenant(tenantId, () => sessionState(staffId, sid));
  } catch {
    return next(new ServiceUnavailableError('Unable to verify account status — please retry'));
  }
  if (!state || !state.isActive) {
    return next(new AuthError('ACCOUNT_INACTIVE', 'Your account has been deactivated'));
  }
  if (!state.sessionLive) {
    return next(new AuthError('TOKEN_REVOKED', 'This session has ended; sign in again'));
  }
  const roles = effectiveRoles(state.assignments, branchId, state.isAllBranches);
  if (roles.length === 0) {
    return next(new BranchAccessError(branchId));
  }
  // An admin reset applies to sessions already open (#38).
  if (state.mustChangePassword && !opts.allowPendingPasswordChange) {
    return next(new PasswordChangeRequiredError());
  }

  req.staff = {
    staffId,
    sessionId: sid,
    role: roles[0] as Role,
    roles,
    branchId,
    permissions: getPermissionsForRoles(roles),
  };
  req.scope = { tenantId, staffId, branchId, allBranches: state.isAllBranches };
  // The rest of the request works in the account's tenant: every database
  // connection it uses carries it.
  runInTenant(tenantId, next);
}
