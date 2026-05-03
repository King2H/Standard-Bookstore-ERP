import { Request, Response, NextFunction } from 'express';
import { Role } from '@bms/shared';
import { AppError, ForbiddenError } from '../lib/errors.js';
import { Permission, ROLE_PERMISSIONS } from '../lib/permissions.js';

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

/**
 * Factory that returns middleware enforcing permission-based access control.
 * Checks req.staff.permissions (from JWT) if present; falls back to
 * ROLE_PERMISSIONS[req.staff.role] for legacy tokens without a permissions array.
 */
export function requirePermission(...required: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.staff) {
      return next(new ForbiddenError('Authentication required'));
    }

    // Use permissions array from JWT if present; fall back to role-derived permissions
    const effective: Permission[] = req.staff.permissions?.length
      ? (req.staff.permissions as Permission[])
      : (ROLE_PERMISSIONS[req.staff.role] ?? []);

    const missing = required.filter(p => !effective.includes(p));
    if (missing.length > 0) {
      return next(
        new AppError(
          'PERMISSION_DENIED',
          `Permission denied. Missing: ${missing.join(', ')}`,
          403,
          { missing },
        ),
      );
    }

    next();
  };
}
