import { Router, Request, Response, NextFunction } from 'express';
import * as paymentsService from './payments.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';
import { withIdempotency, hashBody } from '../../lib/idempotency.js';
import { paramStr } from '../../lib/http.js';

const router = Router();
const qs = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const qi = (v: unknown, fb: number): number => { const s = qs(v); return s ? parseInt(s, 10) || fb : fb; };

// ── GET /api/payments/unpaid-orders ──────────────────────────────────────────
// Returns orders with payment_status = unpaid or partial — for the payment collection UI

router.get(
  '/payments/unpaid-orders',
  authenticate,
  requireRole('Sales', 'Manager', 'Admin', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await paymentsService.listUnpaidOrders({
        branchId:   qi(req.query.branchId, 0) || undefined,
        customerId: qi(req.query.customerId, 0) || undefined,
        page:       qi(req.query.page, 1),
        pageSize:   qi(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── POST /api/payments ────────────────────────────────────────────────────────

router.post(
  '/payments',
  authenticate,
  requireRole('Sales', 'Manager', 'Admin', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.body.orderId) throw new ValidationError('orderId is required');
      if (!req.body.amount) throw new ValidationError('amount is required');
      if (!req.body.paymentMethod) throw new ValidationError('paymentMethod is required');

      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      const body = {
        orderId:              parseInt(req.body.orderId, 10),
        amount:               parseFloat(req.body.amount),
        paymentMethod:        req.body.paymentMethod,
        transactionReference: req.body.transactionReference,
        notes:                req.body.notes,
        bankAccountId:        req.body.bankAccountId ? parseInt(req.body.bankAccountId, 10) : null,
      };

      if (idempotencyKey) {
        const { result, replayed } = await withIdempotency(
          idempotencyKey, '/payments', hashBody(body),
          () => paymentsService.createPayment(body, req.staff!),
        );
        if (replayed) res.setHeader('X-Idempotent-Replayed', 'true');
        res.status(replayed ? 200 : 201).json(result);
      } else {
        const payment = await paymentsService.createPayment(body, req.staff!);
        res.status(201).json(payment);
      }
    } catch (err) { next(err); }
  },
);

// ── GET /api/payments ─────────────────────────────────────────────────────────

router.get(
  '/payments',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await paymentsService.list({
        orderId:       qi(req.query.orderId, 0) || undefined,
        status:        qs(req.query.status),
        paymentMethod: qs(req.query.paymentMethod),
        dateFrom:      qs(req.query.dateFrom),
        dateTo:        qs(req.query.dateTo),
        page:          qi(req.query.page, 1),
        pageSize:      qi(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── GET /api/payments/:id ─────────────────────────────────────────────────────

router.get(
  '/payments/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payment = await paymentsService.getById(parseInt(paramStr(req.params.id), 10));
      res.json(payment);
    } catch (err) { next(err); }
  },
);

// ── POST /api/payments/:id/refund ─────────────────────────────────────────────

router.post(
  '/payments/:id/refund',
  authenticate,
  requireRole('Manager', 'Admin', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.body.refundAmount) throw new ValidationError('refundAmount is required');
      if (!req.body.reason) throw new ValidationError('reason is required');
      const refund = await paymentsService.createRefund(
        parseInt(paramStr(req.params.id), 10),
        {
          refundAmount: parseFloat(req.body.refundAmount),
          reason: req.body.reason,
          bankAccountId: req.body.bankAccountId ? parseInt(req.body.bankAccountId, 10) : null,
        },
        req.staff!,
      );
      res.status(201).json(refund);
    } catch (err) { next(err); }
  },
);

// ── GET /api/payments/:id/refunds ─────────────────────────────────────────────

router.get(
  '/payments/:id/refunds',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payment = await paymentsService.getById(parseInt(paramStr(req.params.id), 10));
      res.json({ items: payment.refunds ?? [] });
    } catch (err) { next(err); }
  },
);

// ── GET /api/orders/:id/payments ──────────────────────────────────────────────

router.get(
  '/orders/:id/payments',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payments = await paymentsService.listByOrder(parseInt(paramStr(req.params.id), 10));
      res.json({ items: payments });
    } catch (err) { next(err); }
  },
);

// ── GET /api/orders/:id/balance ───────────────────────────────────────────────

router.get(
  '/orders/:id/balance',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const balance = await paymentsService.getOrderBalance(parseInt(paramStr(req.params.id), 10));
      res.json(balance);
    } catch (err) { next(err); }
  },
);

export default router;
