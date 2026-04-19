import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@bms/shared';
import { AuthError } from '../lib/errors.js';
import { db } from '../db/index.js';

interface JwtPayload {
  staffId: number;
  role: Role;
  branchId: number;
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AuthError('MISSING_TOKEN', 'Authorization header required'));
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    return next(new AuthError('SERVER_ERROR', 'JWT secret not configured'));
  }

  try {
    const payload = jwt.verify(token, secret) as JwtPayload;

    // F-016: Check staff is still active on every request
    db.query('SELECT is_active FROM staff WHERE id = $1', [payload.staffId])
      .then(result => {
        if (!result.rows.length || !result.rows[0].is_active) {
          return next(new AuthError('ACCOUNT_INACTIVE', 'Your account has been deactivated'));
        }
        req.staff = {
          staffId: payload.staffId,
          role: payload.role,
          branchId: payload.branchId,
        };
        next();
      })
      .catch(() => {
        // DB error — fail open to avoid locking out on transient DB issues
        req.staff = {
          staffId: payload.staffId,
          role: payload.role,
          branchId: payload.branchId,
        };
        next();
      });
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AuthError('TOKEN_EXPIRED', 'Access token has expired'));
    }
    return next(new AuthError('INVALID_TOKEN', 'Invalid access token'));
  }
}
