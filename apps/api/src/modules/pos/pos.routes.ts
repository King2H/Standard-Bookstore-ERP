import { Router, Request, Response, NextFunction } from 'express';
import * as posService from './pos.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const qs = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) ? (v[0] as string | undefined) : undefined;
const qi = (v: unknown, fallback: number): number => {
  const s = qs(v);
  return s ? parseInt(s, 10) || fallback : fallback;
};
const pi = (v: string | string[]): number => parseInt(Array.isArray(v) ? v[0] : v, 10);

// ── POST /api/pos/transactions ────────────────────────────────────────────────

router.post(
  '/pos/transactions',
  authenticate,
  requireRole('Sales', 'Manager', 'Admin', 'Super_Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tx = await posService.createTransaction(
        {
          branchId:    req.body.branchId ?? req.staff!.branchId,
          locationId:  req.body.locationId,
          customerId:  req.body.customerId ?? null,
          items:       req.body.items,
          payments:    req.body.payments ?? [],
          allowCredit: req.body.allowCredit === true,
        },
        req.staff!,
      );
      res.status(201).json(tx);
    } catch (err) { next(err); }
  },
);

// ── GET /api/pos/transactions ─────────────────────────────────────────────────

router.get(
  '/pos/transactions',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await posService.list({
        branchId:      qi(req.query.branchId, 0) || undefined,
        customerId:    qi(req.query.customerId, 0) || undefined,
        staffId:       qi(req.query.staffId, 0) || undefined,
        dateFrom:      qs(req.query.dateFrom),
        dateTo:        qs(req.query.dateTo),
        status:        qs(req.query.status),
        paymentStatus: qs(req.query.paymentStatus),
        transactionNumber: qs(req.query.transactionNumber),
        page:          qi(req.query.page, 1),
        pageSize:      qi(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── GET /api/pos/transactions/:id ─────────────────────────────────────────────

router.get(
  '/pos/transactions/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tx = await posService.getById(pi(req.params.id));
      res.json(tx);
    } catch (err) { next(err); }
  },
);

// ── POST /api/pos/transactions/:id/payment ────────────────────────────────────
// Collect outstanding balance on a credit or partial transaction.

router.post(
  '/pos/transactions/:id/payment',
  authenticate,
  requireRole('Sales', 'Manager', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tx = await posService.recordPayment(pi(req.params.id), req.body.payments, req.staff!);
      res.json(tx);
    } catch (err) { next(err); }
  },
);

// ── POST /api/pos/transactions/:id/void ──────────────────────────────────────

router.post(
  '/pos/transactions/:id/void',
  authenticate,
  requireRole('Manager', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tx = await posService.voidTransaction(pi(req.params.id), req.staff!);
      res.json(tx);
    } catch (err) { next(err); }
  },
);

export default router;
