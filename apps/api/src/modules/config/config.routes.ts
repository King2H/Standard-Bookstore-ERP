import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as configService from './config.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';

const router = Router();

// Helper to safely extract single param (Express 5 compat)
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

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

// ── GET /api/config/currency ──────────────────────────────────────────────────
// Returns the effective currency for the authenticated user's branch.
// Any authenticated staff can call this (needed for POS, Orders, etc.)

router.get(
  '/config/currency',
  authenticate,
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const branchId = req.staff?.branchId;
      const currency = await configService.getEffectiveConfig(branchId ?? 0, 'base_currency');
      res.json({ currency: String(currency ?? 'ETB') });
    } catch {
      res.json({ currency: 'ETB' });
    }
  },
);

router.get(
  '/config/effective',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = req.staff?.branchId ?? 0;
      const rawKeys = Array.isArray(req.query.keys)
        ? req.query.keys.join(',')
        : String(req.query.keys ?? '');
      const keys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);
      if (keys.length === 0) {
        res.json({ items: [] });
        return;
      }

      const items = await Promise.all(keys.map(async (key) => {
        try {
          const { value, source } = await configService.getEffectiveConfigWithSource(branchId, key);
          return { key, value, source };
        } catch {
          return { key, value: null, source: 'system' as const };
        }
      }));

      res.json({ items });
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
      const key = param(req.params.key);
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
      const branchId = parseInt(param(req.params.branchId), 10);
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
      const branchId = parseInt(param(req.params.branchId), 10);
      const key = param(req.params.key);
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
      const branchId = parseInt(param(req.params.branchId), 10);
      const key = param(req.params.key);
      await configService.deleteBranchConfig(branchId, key, req.staff!);
      res.json({ message: `Branch override for '${key}' removed; system default now applies` });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
