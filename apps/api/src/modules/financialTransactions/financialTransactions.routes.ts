import { Router, Request, Response, NextFunction } from 'express';
import * as ftService from './financialTransactions.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';

const router = Router();
const qs = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const qi = (v: unknown, fb: number): number => { const s = qs(v); return s ? parseInt(s, 10) || fb : fb; };

// ── POST /api/financial-transactions ─────────────────────────────────────────

router.post(
  '/financial-transactions',
  authenticate,
  requirePermission('PROCESS_PAYMENT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, orderId, exchangeId, idempotencyKey, amount, currency, method, meta } = req.body as {
        type: string; orderId?: number; exchangeId?: number; idempotencyKey: string;
        amount: number; currency?: string; method?: string; meta?: Record<string, unknown>;
      };

      if (!type || !['payment', 'refund', 'adjustment'].includes(type)) {
        throw new ValidationError('type must be payment, refund, or adjustment');
      }
      if (!idempotencyKey || typeof idempotencyKey !== 'string') {
        throw new ValidationError('idempotencyKey is required');
      }
      if (amount == null || isNaN(Number(amount))) {
        throw new ValidationError('amount is required and must be a number');
      }

      const { transaction, replayed } = await ftService.createTransaction(
        {
          type: type as 'payment' | 'refund' | 'adjustment',
          orderId:    orderId    ?? null,
          exchangeId: exchangeId ?? null,
          idempotencyKey,
          amount: Number(amount),
          currency,
          method,
          meta,
        },
        req.staff!,
      );

      if (replayed) res.setHeader('X-Idempotent-Replayed', 'true');
      res.status(replayed ? 200 : 201).json(transaction);
    } catch (err) { next(err); }
  },
);

// ── GET /api/financial-transactions ──────────────────────────────────────────

router.get(
  '/financial-transactions',
  authenticate,
  requirePermission('VIEW_REPORTS'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await ftService.listTransactions({
        orderId:    qi(req.query.orderId,    0) || undefined,
        exchangeId: qi(req.query.exchangeId, 0) || undefined,
        type:       qs(req.query.type),
        branchId:   qi(req.query.branchId,   0) || req.staff!.branchId,
        page:       qi(req.query.page,    1),
        pageSize:   qi(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

export default router;
