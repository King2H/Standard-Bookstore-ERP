import { Router, Request, Response, NextFunction } from 'express';
import * as receivablesService from './receivables.service.js';
import * as paymentsService from '../payments/payments.service.js';
import * as posService from '../pos/pos.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireRole } from '../../middleware/rbac.js';
import { paramStr } from '../../lib/http.js';
import { ValidationError } from '../../lib/errors.js';

const router = Router();

const qi = (v: unknown): number | undefined => {
  const s = typeof v === 'string' ? v : undefined;
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return isNaN(n) ? undefined : n;
};
const qs = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const qb = (v: unknown): boolean | undefined => v === 'true' ? true : v === 'false' ? false : undefined;

// ── GET /api/receivables/summary ──────────────────────────────────────────────

router.get(
  '/receivables/summary',
  authenticate,
  requirePermission('VIEW_REPORTS'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = qi(req.query.branchId) ?? req.staff?.branchId;
      const summary = await receivablesService.getSummary(branchId);
      res.json(summary);
    } catch (err) { next(err); }
  },
);

// ── GET /api/receivables ──────────────────────────────────────────────────────

router.get(
  '/receivables',
  authenticate,
  requirePermission('PROCESS_PAYMENT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = qi(req.query.branchId) ?? req.staff?.branchId;
      const result = await receivablesService.list({
        branchId,
        customerId:  qi(req.query.customerId),
        status:      qs(req.query.status),
        sourceType:  qs(req.query.sourceType),
        dueDateFrom: qs(req.query.dueDateFrom),
        dueDateTo:   qs(req.query.dueDateTo),
        overdueOnly: qb(req.query.overdueOnly),
        page:        qi(req.query.page),
        pageSize:    qi(req.query.pageSize),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── GET /api/receivables/:id ──────────────────────────────────────────────────

router.get(
  '/receivables/:id',
  authenticate,
  requirePermission('PROCESS_PAYMENT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rec = await receivablesService.getById(paramStr(req.params.id));
      res.json(rec);
    } catch (err) { next(err); }
  },
);

// ── POST /api/receivables/:id/collect ─────────────────────────────────────────
// Module 3: the one action staff use to record "the customer paid" against
// any receivable, regardless of what created it. Routes to the source type's
// own fully-featured payment pipeline (order_credit_sale -> payments.service.
// createPayment, pos_credit_sale -> pos.service.recordPayment,
// exchange_difference -> receivables.service.collectPayment) instead of the
// no-op status flip that used to be the only option here.

router.post(
  '/receivables/:id/collect',
  authenticate,
  requirePermission('PROCESS_PAYMENT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = paramStr(req.params.id);
      const { amount, paymentMethod, bankAccountId, notes } = req.body as {
        amount: number;
        paymentMethod: 'cash' | 'bank' | 'mobile' | 'store_credit';
        bankAccountId?: number | null;
        notes?: string;
      };
      if (!paymentMethod) throw new ValidationError('paymentMethod is required');

      const receivable = await receivablesService.getById(id);
      if (receivable.sourceType === 'order_credit_sale') {
        await paymentsService.createPayment(
          { orderId: parseInt(receivable.sourceEntityId, 10), amount, paymentMethod, bankAccountId, notes },
          req.staff!,
        );
      } else if (receivable.sourceType === 'pos_credit_sale') {
        await posService.recordPayment(
          receivable.sourceEntityId,
          [{ method: paymentMethod, amount, reference: notes }],
          req.staff!,
        );
      } else {
        await receivablesService.collectPayment(id, { amount, paymentMethod, bankAccountId, notes }, req.staff!);
      }

      res.json(await receivablesService.getById(id));
    } catch (err) { next(err); }
  },
);

// ── POST /api/receivables/:id/settle (write-off — no payment collected) ───────
// Restricted to Admin/Manager/Finance_Officer: unlike /collect above, this
// records no money movement anywhere. Bad-debt write-off, not routine
// "the customer paid" settlement.

router.post(
  '/receivables/:id/settle',
  authenticate,
  requireRole('Admin', 'Manager', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rec = await receivablesService.manualSettle(
        paramStr(req.params.id),
        typeof req.body.notes === 'string' ? req.body.notes : undefined,
        req.staff!,
      );
      res.json(rec);
    } catch (err) { next(err); }
  },
);

// ── PATCH /api/receivables/:id/due-date ───────────────────────────────────────

router.patch(
  '/receivables/:id/due-date',
  authenticate,
  requirePermission('PROCESS_PAYMENT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dueDate = req.body.dueDate === null ? null : (typeof req.body.dueDate === 'string' ? req.body.dueDate : null);
      const rec = await receivablesService.updateDueDate(paramStr(req.params.id), dueDate, req.staff!);
      res.json(rec);
    } catch (err) { next(err); }
  },
);

export default router;
