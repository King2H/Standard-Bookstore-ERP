import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as staffService from './staff.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError, BusinessError, ForbiddenError } from '../../lib/errors.js';
import { db } from '../../db/index.js';
import { paramInt } from '../../lib/http.js';

// Staff administration, still in its v1 form; it moves to the layered
// structure in auth part 2 (#21). Signing in and the signed-in staff member's
// own profile are in modules/auth.

const router = Router();

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

      // Fetch is_all_branches separately — resilient to missing column on older DBs
      const allBranchesMap: Record<number, boolean> = {};
      try {
        const abRes = await db.query(`SELECT id, is_all_branches FROM staff`);
        for (const row of abRes.rows) {
          allBranchesMap[row.id as number] = row.is_all_branches === true;
        }
      } catch { /* column not yet added */ }

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
          isAllBranches: allBranchesMap[r.id as number] ?? false,
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

      const { staffId } = await staffService.createStaff(parsed.data);
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
      const staffId = paramInt(req.params.id);
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
      const staffId = paramInt(req.params.id);

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

      await staffService.deactivateStaff(staffId);
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
      const staffId = paramInt(req.params.id);
      await staffService.reactivateStaff(staffId);
      res.json({ message: 'Staff reactivated' });
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/staff/:id/all-branches ──────────────────────────────────────────
// Admin/Super_Admin can grant or revoke all-branch access for any staff member.

router.put(
  '/staff/:id/all-branches',
  authenticate,
  requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffId = paramInt(req.params.id);
      const { isAllBranches } = req.body;
      if (typeof isAllBranches !== 'boolean') {
        throw new ValidationError('isAllBranches must be a boolean');
      }

      await db.query(
        `UPDATE staff SET is_all_branches = $1 WHERE id = $2`,
        [isAllBranches, staffId],
      );

      await db.query(
        `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'UPDATE', 'staff', $3, $4)`,
        [
          req.staff!.staffId,
          req.staff!.role,
          String(staffId),
          JSON.stringify({ action: 'set_all_branches', isAllBranches }),
        ],
      );

      res.json({ message: isAllBranches ? 'All-branch access granted' : 'All-branch access revoked' });
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
      const staffId = paramInt(req.params.id);
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

      await staffService.assignRoles(staffId, parsed.data);
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
      const staffId = paramInt(req.params.id);
      const staff = await staffService.getStaffById(staffId);
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
      const staffId = paramInt(req.params.id);
      const { temporaryPassword } = req.body;
      if (!temporaryPassword || typeof temporaryPassword !== 'string') {
        throw new ValidationError('temporaryPassword is required');
      }
      await staffService.adminResetPassword(staffId, temporaryPassword, req.staff!);
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
      const staffId = paramInt(req.params.id);
      await staffService.unlockAccount(staffId, req.staff!);
      res.json({ message: 'Account unlocked' });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
