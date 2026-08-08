import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as locationService from './location.service.js';
import * as locationAccessService from './locationAccess.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';
import { paramInt } from '../../lib/http.js';

const router = Router();

// â”€â”€ Validation schemas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const nameSchema = z.object({
  name: z.string().min(1).max(100),
});

// â”€â”€ GET /api/branches/:branchId/locations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Access-aware: Admin/Manager see all locations.
// Restricted staff (with explicit location assignments) see only their assigned locations.
// Unrestricted staff (no assignments) see all locations in their branch (fallback mode).

router.get(
  '/branches/:branchId/locations',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = paramInt(req.params.branchId);
      const role = req.staff!.role;

      // Admins and Managers always see all locations â€” they manage them
      if (['Super_Admin', 'Admin', 'Manager'].includes(role)) {
        const locations = await locationService.listLocations(branchId);
        return res.json({ items: locations, total: locations.length, accessMode: 'full' });
      }

      // All other roles: return only their accessible locations (respects restrictions)
      const staffCtx = { ...req.staff!, branchId };
      const locations = await locationAccessService.getAccessibleLocations(staffCtx);

      // Determine whether this staff member is in restricted or fallback mode
      const assignments = await locationAccessService.getStaffLocationAssignments(req.staff!.staffId);
      const isRestricted = assignments.some(a => a.branchId === branchId);

      res.json({
        items: locations,
        total: locations.length,
        accessMode: isRestricted ? 'restricted' : 'full',
      });
    } catch (err) {
      next(err);
    }
  },
);

// â”€â”€ POST /api/branches/:branchId/locations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.post(
  '/branches/:branchId/locations',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = paramInt(req.params.branchId);
      const parsed = nameSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid location payload', { issues: parsed.error.issues });
      }

      const location = await locationService.createLocation(branchId, parsed.data.name, req.staff!);
      res.status(201).json(location);
    } catch (err) {
      next(err);
    }
  },
);

// â”€â”€ PUT /api/branches/:branchId/locations/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Rename

router.put(
  '/branches/:branchId/locations/:id',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      const parsed = nameSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid location payload', { issues: parsed.error.issues });
      }

      const location = await locationService.renameLocation(id, parsed.data.name, req.staff!);
      res.json(location);
    } catch (err) {
      next(err);
    }
  },
);

// â”€â”€ PUT /api/branches/:branchId/locations/:id/set-default â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.put(
  '/branches/:branchId/locations/:id/set-default',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      const location = await locationService.setDefaultLocation(id, req.staff!);
      res.json(location);
    } catch (err) {
      next(err);
    }
  },
);

// â”€â”€ DELETE /api/branches/:branchId/locations/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.delete(
  '/branches/:branchId/locations/:id',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramInt(req.params.id);
      await locationService.deleteLocation(id, req.staff!);
      res.json({ message: 'Location deleted' });
    } catch (err) {
      next(err);
    }
  },
);

// â”€â”€ GET /api/staff/:id/locations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns the explicit location assignments for a staff member.
// Empty array means fallback mode (full branch access).

router.get(
  '/staff/:id/locations',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffId = paramInt(req.params.id);
      const assignments = await locationAccessService.getStaffLocationAssignments(staffId);
      res.json({
        items: assignments,
        total: assignments.length,
        fallbackMode: assignments.length === 0,
      });
    } catch (err) {
      next(err);
    }
  },
);

// â”€â”€ PUT /api/staff/:id/locations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Full replace of location assignments for a staff member.
// Send empty array [] to clear restrictions (restore fallback / full-branch-access mode).

router.put(
  '/staff/:id/locations',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffId = paramInt(req.params.id);
      const parsed = z.array(z.number().int().positive()).safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Body must be an array of location IDs', { issues: parsed.error.issues });
      }

      await locationAccessService.assignLocationsToStaff(staffId, parsed.data, req.staff!);
      res.json({
        message: parsed.data.length === 0
          ? 'Location restrictions cleared â€” staff now has full branch access'
          : `Location access restricted to ${parsed.data.length} location(s)`,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
