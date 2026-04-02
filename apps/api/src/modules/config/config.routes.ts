import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as configService from './config.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';

const router = Router();

// ── Validation ────────────────────────────────────────────────────────────────

const setConfigSchema = z.object({
  value: z.unknown(),
});

// ── GET /api/config/system ────────────────────────────────────────────────────
// Super_Admin, Admin, Manager can read system config

router.get(
  '/config/system',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await configService.listSystemConfig();
      res.json({ items: rows, total: rows.length });
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/config/system/:key ───────────────────────────────────────────────
// Super_Admin only (enforced in service layer too)

router.put(
  '/config/system/:key',
  authenticate,
  requireRole('Super_Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key } = req.params;
      const parsed = setConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid config payload', { issues: parsed.error.issues });
      }

      const row = await configService.setSystemConfig(key, parsed.data.value, req.staff!);
      res.json(row);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/config/branches/:branchId ───────────────────────────────────────
// Returns merged effective config (branch overrides + system defaults) with source label

router.get(
  '/config/branches/:branchId',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = parseInt(req.params.branchId, 10);
      const rows = await configService.getEffectiveBranchConfig(branchId);
      res.json({ items: rows, total: rows.length });
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/config/branches/:branchId/:key ───────────────────────────────────

router.put(
  '/config/branches/:branchId/:key',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = parseInt(req.params.branchId, 10);
      const { key } = req.params;
      const parsed = setConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid config payload', { issues: parsed.error.issues });
      }

      const row = await configService.setBranchConfig(branchId, key, parsed.data.value, req.staff!);
      res.json(row);
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/config/branches/:branchId/:key ────────────────────────────────
// Removes branch override; key falls back to system default

router.delete(
  '/config/branches/:branchId/:key',
  authenticate,
  requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = parseInt(req.params.branchId, 10);
      const { key } = req.params;
      await configService.deleteBranchConfig(branchId, key, req.staff!);
      res.json({ message: `Branch override for '${key}' removed; system default now applies` });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
