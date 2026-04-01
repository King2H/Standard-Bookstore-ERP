import { Request, Response, NextFunction } from 'express';
import { Role } from '@bms/shared';
import { ForbiddenError } from '../lib/errors.js';

/**
 * Factory that returns middleware enforcing role-based access control.
 * RBAC is enforced at the API layer — never rely on client-side checks.
 */
export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.staff) {
      return next(new ForbiddenError('Authentication required'));
    }

    if (!allowedRoles.includes(req.staff.role)) {
      return next(
        new ForbiddenError(
          `Role '${req.staff.role}' is not permitted to perform this action`,
        ),
      );
    }

    next();
  };
}
