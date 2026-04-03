import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as locationService from './location.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';

const router = Router();

// ── Validation schemas ────────────────────────────────────────────────────────

const nameSchema = z.object({
  name: z.string().min(1).max(100),
});

// ── GET /api/branches/:branchId/locations ─────────────────────────────────────

router.get(
  '/branches/:branchId/locations',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = parseInt(req.params.branchId, 10);
      const locations = await locationService.listLocations(branchId);
      res.json({ items: locations, total: locations.length });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/branches/:branchId/locations ────────────────────────────────────

router.post(
  '/branches/:branchId/locations',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = parseInt(req.params.branchId, 10);
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

// ── PUT /api/branches/:branchId/locations/:id ─────────────────────────────────
// Rename

router.put(
  '/branches/:branchId/locations/:id',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
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

// ── PUT /api/branches/:branchId/locations/:id/set-default ────────────────────

router.put(
  '/branches/:branchId/locations/:id/set-default',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      const location = await locationService.setDefaultLocation(id, req.staff!);
      res.json(location);
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/branches/:branchId/locations/:id ──────────────────────────────

router.delete(
  '/branches/:branchId/locations/:id',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      await locationService.deleteLocation(id, req.staff!);
      res.json({ message: 'Location deleted' });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
