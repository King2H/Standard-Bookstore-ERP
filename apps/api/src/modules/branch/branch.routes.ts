import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as branchService from './branch.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';

const router = Router();

// ── Validation schemas ────────────────────────────────────────────────────────

const createBranchSchema = z.object({
  name: z.string().min(1).max(100),
  address: z.string().min(1),
  contactInfo: z.object({
    phone: z.string().optional().default(''),
    email: z.string().optional().default(''),
  }).default({}),
  operatingHours: z.record(z.string()).default({
    mon: '09:00-18:00',
    tue: '09:00-18:00',
    wed: '09:00-18:00',
    thu: '09:00-18:00',
    fri: '09:00-18:00',
    sat: '10:00-16:00',
    sun: 'closed',
  }),
});

const updateBranchSchema = createBranchSchema.partial();

// Helper to safely extract single param (Express 5 compat)
const param = (v: string | string[]): string => Array.isArray(v) ? v[0] : v;

// ── GET /api/branches/public — no auth required, for login page ───────────────

router.get('/branches/public', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await branchService.listBranches({ isActive: true, page: 1, pageSize: 100 });
    res.json({ items: result.items.map(b => ({ id: b.id, name: b.name })) });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/branches ─────────────────────────────────────────────────────────

router.get('/branches', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string ?? '1', 10);
    const pageSize = Math.min(parseInt(req.query.pageSize as string ?? '25', 10), 100);
    const isActive = req.query.isActive !== undefined
      ? req.query.isActive === 'true'
      : undefined;

    const result = await branchService.listBranches({ isActive, page, pageSize });

    res.json({
      ...result,
      page,
      pageSize,
      totalPages: Math.ceil(result.total / pageSize),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/branches/:id ─────────────────────────────────────────────────────

router.get('/branches/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(param(req.params.id), 10);
    const branch = await branchService.getBranch(id);
    res.json(branch);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/branches ────────────────────────────────────────────────────────

router.post(
  '/branches',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createBranchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid branch payload', { issues: parsed.error.issues });
      }

      const branch = await branchService.createBranch(parsed.data, req.staff!);
      res.status(201).json(branch);
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/branches/:id ─────────────────────────────────────────────────────

router.put(
  '/branches/:id',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(param(req.params.id), 10);
      const parsed = updateBranchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid branch update payload', { issues: parsed.error.issues });
      }

      const branch = await branchService.updateBranch(id, parsed.data, req.staff!);
      res.json(branch);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/branches/:id/deactivate ─────────────────────────────────────────

router.post(
  '/branches/:id/deactivate',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(param(req.params.id), 10);
      await branchService.deactivateBranch(id, req.staff!);
      res.json({ message: 'Branch deactivated' });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/branches/:id/reactivate ─────────────────────────────────────────

router.post(
  '/branches/:id/reactivate',
  authenticate,
  requireRole('Super_Admin', 'Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(param(req.params.id), 10);
      await branchService.reactivateBranch(id, req.staff!);
      res.json({ message: 'Branch reactivated' });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /api/branches/:id ──────────────────────────────────────────────────

router.delete(
  '/branches/:id',
  authenticate,
  requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(param(req.params.id), 10);
      await branchService.deleteBranch(id, req.staff!);
      res.json({ message: 'Branch deleted' });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
