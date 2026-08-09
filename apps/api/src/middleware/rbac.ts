import { Request, Response, NextFunction } from 'express';
import { Role } from '@bms/shared';
import { AppError, ForbiddenError } from '../lib/errors.js';
import { Permission, ROLE_PERMISSIONS } from '../lib/permissions.js';

/**
 * Factory that returns middleware enforcing role-based access control.
 * RBAC is enforced at the API layer — never rely on client-side checks.
 *
 * Bug fix: this used to check only req.staff.role — the single "primary"
 * role recorded on the JWT (whichever role login happened to pick first
 * for the active branch). A staff member holding multiple roles on the
 * same branch (e.g. Sales + Stock_Clerk + Purchasor) was denied by any
 * requireRole(...) gate that didn't happen to list their primary role,
 * even when one of their OTHER held roles was explicitly allowed — e.g.
 * Purchasor/Stock_Clerk could not create a supplier via POST /suppliers
 * (requireRole('Admin','Manager','Purchasor','Stock_Clerk')) whenever
 * 'Sales' was their primary role, despite Purchasor being both held and
 * listed as allowed. req.staff.roles (the full set of roles for the
 * active branch, populated in middleware/auth.ts) already exists
 * specifically to support this — requirePermission() below already reads
 * the equivalent union via req.staff.permissions; requireRole() just
 * wasn't wired to it. Now passes if ANY held role is in the allowed list,
 * matching the project's documented multi-role model ("effective
 * permissions are the union of all assigned roles") without changing
 * single-role behavior at all (roles falls back to [role] when absent).
 */
export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.staff) {
      return next(new ForbiddenError('Authentication required'));
    }

    const effectiveRoles: Role[] = req.staff.roles?.length
      ? (req.staff.roles as Role[])
      : [req.staff.role];

    if (!effectiveRoles.some(r => allowedRoles.includes(r))) {
      return next(
        new ForbiddenError(
          effectiveRoles.length > 1
            ? `None of your roles (${effectiveRoles.join(', ')}) are permitted to perform this action`
            : `Role '${req.staff.role}' is not permitted to perform this action`,
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
