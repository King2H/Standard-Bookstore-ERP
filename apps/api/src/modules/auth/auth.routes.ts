import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import * as authService from './auth.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError, BusinessError, ForbiddenError } from '../../lib/errors.js';
import { db } from '../../db/index.js';

const router = Router();

// ── Validation schemas ────────────────────────────────────────────────────────

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  branchId: z.number().int().positive(),
});

const createStaffSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(10),
  fullName: z.string().min(1).max(100),
});

const assignRolesSchema = z.array(
  z.object({
    branchId: z.number().int().positive(),
    role: z.enum(['Super_Admin', 'Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor']),
  }),
);

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post('/auth/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid login payload', { issues: parsed.error.issues });
    }

    const { username, password, branchId } = parsed.data;
    const result = await authService.login(username, password, branchId);

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({ accessToken: result.accessToken, expiresIn: result.expiresIn, mustChangePassword: result.mustChangePassword });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

router.post('/auth/logout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken && req.staff) {
      await authService.logout(req.staff.staffId, refreshToken);
    }
    res.clearCookie('refreshToken');
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────

router.post('/auth/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      return next({ statusCode: 401, code: 'MISSING_REFRESH_TOKEN', message: 'Refresh token required' });
    }

    const result = await authService.refresh(refreshToken);
    res.json({ accessToken: result.accessToken, expiresIn: result.expiresIn });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/staff/me ─────────────────────────────────────────────────────────
// Any authenticated staff member can view their own profile

router.get(
  '/staff/me',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffId = req.staff!.staffId;
      const currentBranchId = req.staff!.branchId;

      const result = await db.query(
        `SELECT s.id, s.username, s.full_name, s.is_active, s.created_at,
                s.must_change_password, s.last_login_at, s.password_changed_at,
                s.failed_login_attempts, s.locked_until,
                COALESCE(json_agg(
                  json_build_object('branchId', sbr.branch_id, 'branchName', b.name, 'role', sbr.role)
                ) FILTER (WHERE sbr.staff_id IS NOT NULL), '[]') AS roles
         FROM staff s
         LEFT JOIN staff_branch_roles sbr ON sbr.staff_id = s.id
         LEFT JOIN branches b ON b.id = sbr.branch_id
         WHERE s.id = $1
         GROUP BY s.id`,
        [staffId],
      );

      if (result.rows.length === 0) {
        return next(new ValidationError('Staff not found'));
      }

      // Fetch location access scope for the current branch session
      const locationAssignments = await db.query(
        `SELECT l.id, l.name, l.is_default_fulfillment
         FROM staff_locations sl
         JOIN locations l ON l.id = sl.location_id
         WHERE sl.staff_id = $1 AND l.branch_id = $2
         ORDER BY l.is_default_fulfillment DESC, l.name ASC`,
        [staffId, currentBranchId],
      );

      const isLocationRestricted = locationAssignments.rows.length > 0;
      const locationAccess = {
        mode: isLocationRestricted ? 'restricted' : 'full',
        locations: isLocationRestricted
          ? locationAssignments.rows.map((l: Record<string, unknown>) => ({
              id: l.id,
              name: l.name,
              isDefaultFulfillment: l.is_default_fulfillment,
            }))
          : [],
      };

      const r = result.rows[0];
      res.json({
        id: r.id,
        username: r.username,
        fullName: r.full_name,
        isActive: r.is_active,
        createdAt: r.created_at,
        mustChangePassword: r.must_change_password,
        lastLoginAt: r.last_login_at,
        passwordChangedAt: r.password_changed_at,
        isLocked: r.locked_until && new Date(r.locked_until) > new Date(),
        roles: r.roles,
        currentRole: req.staff!.role,
        currentBranchId,
        locationAccess,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/staff/me/password ────────────────────────────────────────────────
// Any authenticated staff member can change their own password

router.put(
  '/staff/me/password',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffId = req.staff!.staffId;
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || typeof currentPassword !== 'string') {
        throw new ValidationError('currentPassword is required');
      }
      if (!newPassword || typeof newPassword !== 'string') {
        throw new ValidationError('newPassword is required');
      }

      // Validate new password complexity
      const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{10,}$/;
      if (!PASSWORD_REGEX.test(newPassword)) {
        throw new ValidationError(
          'New password must be at least 10 characters and contain uppercase, lowercase, digit, and special character',
        );
      }

      // Verify current password
      const staffResult = await db.query(
        `SELECT password_hash FROM staff WHERE id = $1`,
        [staffId],
      );
      if (staffResult.rows.length === 0) {
        throw new ValidationError('Staff not found');
      }

      const valid = await bcrypt.compare(currentPassword, staffResult.rows[0].password_hash);
      if (!valid) {
        throw new BusinessError('INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
      }

      // Hash and save new password
      const newHash = await bcrypt.hash(newPassword, 12);
      await db.query(
        `UPDATE staff SET password_hash = $1, must_change_password = false, password_changed_at = now() WHERE id = $2`,
        [newHash, staffId],
      );

      // Audit log
      await db.query(
        `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'UPDATE', 'staff', $3, $4)`,
        [staffId, req.staff!.role, String(staffId), JSON.stringify({ action: 'password_changed' })],
      );

      res.json({ message: 'Password updated successfully' });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/staff ────────────────────────────────────────────────────────────

router.get(
  '/staff',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = parseInt(req.query.page as string ?? '1', 10);
      const pageSize = parseInt(req.query.pageSize as string ?? '25', 10);

      // Manager can only see staff in their own branch
      let branchFilter = '';
      const params: unknown[] = [pageSize, (page - 1) * pageSize];

      if (req.staff!.role === 'Manager') {
        branchFilter = `WHERE s.id IN (
          SELECT staff_id FROM staff_branch_roles WHERE branch_id = $3
        )`;
        params.push(req.staff!.branchId);
      }

      const result = await db.query(
        `SELECT s.id, s.username, s.full_name, s.is_active, s.created_at,
                s.must_change_password, s.locked_until, s.failed_login_attempts,
                COALESCE(json_agg(
                  json_build_object('branchId', sbr.branch_id, 'branchName', b.name, 'role', sbr.role)
                ) FILTER (WHERE sbr.staff_id IS NOT NULL), '[]') AS roles
         FROM staff s
         LEFT JOIN staff_branch_roles sbr ON sbr.staff_id = s.id
         LEFT JOIN branches b ON b.id = sbr.branch_id
         ${branchFilter}
         GROUP BY s.id
         ORDER BY s.username ASC
         LIMIT $1 OFFSET $2`,
        params,
      );

      const countResult = await db.query(
        `SELECT COUNT(DISTINCT s.id) FROM staff s
         ${branchFilter}`,
        branchFilter ? [params[2]] : [],
      );

      res.json({
        items: result.rows.map((r) => ({
          id: r.id,
          username: r.username,
          fullName: r.full_name,
          isActive: r.is_active,
          createdAt: r.created_at,
          mustChangePassword: r.must_change_password,
          lockedUntil: r.locked_until,
          failedLoginAttempts: r.failed_login_attempts,
          roles: r.roles,
        })),
        total: parseInt(countResult.rows[0].count, 10),
        page,
        pageSize,
        totalPages: Math.ceil(parseInt(countResult.rows[0].count, 10) / pageSize),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/staff ───────────────────────────────────────────────────────────

router.post(
  '/staff',
  authenticate,
  requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createStaffSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid staff payload', { issues: parsed.error.issues });
      }

      const { staffId } = await authService.createStaff(parsed.data);
      res.status(201).json({ staffId });
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/staff/:id ────────────────────────────────────────────────────────

router.put(
  '/staff/:id',
  authenticate,
  requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffId = parseInt(req.params.id as string, 10);
      const { fullName } = req.body;
      if (!fullName || typeof fullName !== 'string') {
        throw new ValidationError('fullName is required');
      }

      await db.query(
        `UPDATE staff SET full_name = $1 WHERE id = $2`,
        [fullName, staffId],
      );

      await db.query(
        `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'UPDATE', 'staff', $3, $4)`,
        [req.staff!.staffId, req.staff!.role, String(staffId), JSON.stringify({ fullName })],
      );

      res.json({ message: 'Staff updated' });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/staff/:id/deactivate ────────────────────────────────────────────

router.post(
  '/staff/:id/deactivate',
  authenticate,
  requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffId = parseInt(req.params.id as string, 10);

      // A staff member cannot deactivate themselves
      if (staffId === req.staff!.staffId) {
        return next(new BusinessError(
          'CANNOT_DEACTIVATE_SELF',
          'You cannot deactivate your own account.',
        ));
      }

      // Check if target staff has Super_Admin role anywhere
      const targetRoles = await db.query(
        `SELECT sbr.role FROM staff_branch_roles sbr WHERE sbr.staff_id = $1`,
        [staffId],
      );

      const isSuperAdmin = targetRoles.rows.some(
        (r: { role: string }) => r.role === 'Super_Admin',
      );

      if (isSuperAdmin) {
        // Only another Super_Admin can deactivate a Super_Admin
        if (req.staff!.role !== 'Super_Admin') {
          return next(new ForbiddenError('Only a Super_Admin can deactivate another Super_Admin'));
        }

        // Cannot deactivate the last active Super_Admin
        const activeCount = await db.query(
          `SELECT COUNT(DISTINCT s.id) FROM staff s
           JOIN staff_branch_roles sbr ON sbr.staff_id = s.id
           WHERE sbr.role = 'Super_Admin' AND s.is_active = true`,
        );
        if (parseInt(activeCount.rows[0].count, 10) <= 1) {
          return next(new BusinessError(
            'CANNOT_DEACTIVATE_LAST_SUPER_ADMIN',
            'Cannot deactivate the last active Super_Admin. Create another Super_Admin first.',
          ));
        }
      }

      await authService.deactivateStaff(staffId);
      res.json({ message: 'Staff deactivated' });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/staff/:id/reactivate ────────────────────────────────────────────

router.post(
  '/staff/:id/reactivate',
  authenticate,
  requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffId = parseInt(req.params.id as string, 10);
      await authService.reactivateStaff(staffId);
      res.json({ message: 'Staff reactivated' });
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/staff/:id/roles ──────────────────────────────────────────────────

router.put(
  '/staff/:id/roles',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffId = parseInt(req.params.id as string, 10);
      const parsed = assignRolesSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid roles payload', { issues: parsed.error.issues });
      }

      // Manager can only assign non-Super_Admin roles
      if (req.staff!.role === 'Manager') {
        const hasSuperAdmin = parsed.data.some(r => r.role === 'Super_Admin');
        if (hasSuperAdmin) {
          return next(new ForbiddenError('Managers cannot assign Super_Admin role'));
        }
      }

      await authService.assignRoles(staffId, parsed.data);
      res.json({ message: 'Roles updated' });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/staff/:id ────────────────────────────────────────────────────────
// Admin+ can view full staff detail including security status

router.get(
  '/staff/:id',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffId = parseInt(req.params.id as string, 10);
      const staff = await authService.getStaffById(staffId);
      res.json(staff);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/staff/:id/reset-password ────────────────────────────────────────
// Admin sets a temporary password; staff must change on next login

router.post(
  '/staff/:id/reset-password',
  authenticate,
  requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffId = parseInt(req.params.id as string, 10);
      const { temporaryPassword } = req.body;
      if (!temporaryPassword || typeof temporaryPassword !== 'string') {
        throw new ValidationError('temporaryPassword is required');
      }
      await authService.adminResetPassword(staffId, temporaryPassword, req.staff!);
      res.json({ message: 'Password reset. Staff must change password on next login.' });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/staff/:id/unlock ────────────────────────────────────────────────
// Admin clears lockout and resets failed attempt counter

router.post(
  '/staff/:id/unlock',
  authenticate,
  requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffId = parseInt(req.params.id as string, 10);
      await authService.unlockAccount(staffId, req.staff!);
      res.json({ message: 'Account unlocked' });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
