import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@bms/shared';
import { AuthError, ServiceUnavailableError } from '../lib/errors.js';
import { db } from '../db/index.js';

interface JwtPayload {
  staffId: number;
  role: Role;
  roles?: string[];    // all roles for the active branch (added in refactor)
  branchId: number;
  permissions?: string[];
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
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
  try {
    const result = await db.query('SELECT is_active FROM staff WHERE id = $1', [payload.staffId]);
    if (!result.rows.length || !result.rows[0].is_active) {
      return next(new AuthError('ACCOUNT_INACTIVE', 'Your account has been deactivated'));
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
  next();
}
