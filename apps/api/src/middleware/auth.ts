import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@bms/shared';
import { AuthError } from '../lib/errors.js';

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
    req.staff = {
      staffId: payload.staffId,
      role: payload.role,
      branchId: payload.branchId,
    };
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AuthError('TOKEN_EXPIRED', 'Access token has expired'));
    }
    return next(new AuthError('INVALID_TOKEN', 'Invalid access token'));
  }
}
