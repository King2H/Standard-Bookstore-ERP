import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as bankAccountService from './bankAccount.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';
import { paramStr } from '../../lib/http.js';

const router = Router({ mergeParams: true });

// ── Validation schemas ────────────────────────────────────────────────────────

const createSchema = z.object({
  accountName:   z.string().min(1).max(100),
  bankName:      z.string().min(1).max(100),
  accountNumber: z.string().min(1),
  iban:          z.string().optional().nullable(),
  currency:      z.string().length(3, 'Currency must be a 3-letter ISO 4217 code').toUpperCase(),
});

const updateSchema = createSchema.partial();

const csvRowSchema = z.object({
  amount:        z.number().positive(),
  direction:     z.enum(['in', 'out']),
  statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  notes:         z.string().optional(),
});

const importSchema = z.object({
  rows: z.array(csvRowSchema).min(1, 'At least one row required'),
});

const clearSchema = z.object({
  paymentRefId: z.number().int().positive().optional().nullable(),
});

// ── GET /api/branches/:branchId/bank-accounts ─────────────────────────────────

router.get(
  '/branches/:branchId/bank-accounts',
  authenticate,
  requireRole('Admin', 'Manager', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = parseInt(paramStr(req.params.branchId), 10);
      const page = parseInt(req.query.page as string ?? '1', 10);
      const pageSize = Math.min(parseInt(req.query.pageSize as string ?? '25', 10), 100);
      const isActive = req.query.isActive !== undefined
        ? req.query.isActive === 'true'
        : undefined;

      const result = await bankAccountService.listBankAccounts(branchId, { isActive, page, pageSize });
      res.json({ ...result, page, pageSize, totalPages: Math.ceil(result.total / pageSize) });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/branches/:branchId/bank-accounts ────────────────────────────────

router.post(
  '/branches/:branchId/bank-accounts',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = parseInt(paramStr(req.params.branchId), 10);
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid bank account payload', { issues: parsed.error.issues });
      }

      const account = await bankAccountService.createBankAccount(
        { branchId, ...parsed.data },
        req.staff!,
      );
      res.status(201).json(account);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/branches/:branchId/bank-accounts/:id ────────────────────────────

router.get(
  '/branches/:branchId/bank-accounts/:id',
  authenticate,
  requireRole('Admin', 'Manager', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(paramStr(req.params.id), 10);
      const account = await bankAccountService.getBankAccount(id);
      res.json(account);
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/branches/:branchId/bank-accounts/:id ────────────────────────────

router.put(
  '/branches/:branchId/bank-accounts/:id',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(paramStr(req.params.id), 10);
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid bank account update payload', { issues: parsed.error.issues });
      }

      const account = await bankAccountService.updateBankAccount(id, parsed.data, req.staff!);
      res.json(account);
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/branches/:branchId/bank-accounts/:id/deactivate ────────────────

router.post(
  '/branches/:branchId/bank-accounts/:id/deactivate',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(paramStr(req.params.id), 10);
      await bankAccountService.deactivateBankAccount(id, req.staff!);
      res.json({ message: 'Bank account deactivated' });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/branches/:branchId/reconciliation ────────────────────────────────

router.get(
  '/branches/:branchId/reconciliation',
  authenticate,
  requireRole('Admin', 'Manager', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bankAccountId = parseInt(req.query.bankAccountId as string, 10);
      if (isNaN(bankAccountId)) {
        throw new ValidationError('bankAccountId query param is required');
      }
      const page = parseInt(req.query.page as string ?? '1', 10);
      const pageSize = Math.min(parseInt(req.query.pageSize as string ?? '25', 10), 100);
      const status = req.query.status as string | undefined;

      const result = await bankAccountService.listReconciliation(bankAccountId, { status, page, pageSize });
      res.json({ ...result, page, pageSize });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/branches/:branchId/reconciliation/import ───────────────────────
// Accepts JSON body with { rows: CsvRow[] } — CSV parsing is done client-side

router.post(
  '/branches/:branchId/reconciliation/import',
  authenticate,
  requireRole('Admin', 'Manager', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bankAccountId = parseInt(req.query.bankAccountId as string, 10);
      if (isNaN(bankAccountId)) {
        throw new ValidationError('bankAccountId query param is required');
      }

      const parsed = importSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid import payload', { issues: parsed.error.issues });
      }

      const result = await bankAccountService.importReconciliation(
        bankAccountId,
        parsed.data.rows,
        req.staff!,
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/branches/:branchId/reconciliation/:entryId ──────────────────────

router.put(
  '/branches/:branchId/reconciliation/:entryId',
  authenticate,
  requireRole('Admin', 'Manager', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const entryId = parseInt(paramStr(req.params.entryId), 10);
      const parsed = clearSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid clear payload', { issues: parsed.error.issues });
      }

      const entry = await bankAccountService.clearEntry(entryId, parsed.data.paymentRefId ?? null, req.staff!);
      res.json(entry);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
