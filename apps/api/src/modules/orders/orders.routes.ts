import { Router, Request, Response, NextFunction } from 'express';
import * as ordersService from './orders.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';
import { withIdempotency, hashBody } from '../../lib/idempotency.js';

const router = Router();
const qs = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const qi = (v: unknown, fb: number): number => { const s = qs(v); return s ? parseInt(s, 10) || fb : fb; };

// ── POST /api/orders ──────────────────────────────────────────────────────────

router.post(
  '/orders',
  authenticate,
  requireRole('Sales', 'Manager', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.body.items || !Array.isArray(req.body.items) || req.body.items.length === 0) {
        throw new ValidationError('items array is required');
      }
      const body = {
        customerId: req.body.customerId ?? null,
        locationId: req.body.locationId ?? null,
        channel:    req.body.channel ?? 'in_store',
        notes:      req.body.notes,
        items:      req.body.items,
      };
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      if (idempotencyKey) {
        const { result, replayed } = await withIdempotency(
          idempotencyKey, '/orders', hashBody(body),
          () => ordersService.create(body, req.staff!),
        );
        if (replayed) res.setHeader('X-Idempotent-Replayed', 'true');
        res.status(replayed ? 200 : 201).json(result);
      } else {
        const order = await ordersService.create(body, req.staff!);
        res.status(201).json(order);
      }
    } catch (err) { next(err); }
  },
);

// ── GET /api/orders ───────────────────────────────────────────────────────────

router.get(
  '/orders',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await ordersService.list({
        branchId:      qi(req.query.branchId, 0) || undefined,
        customerId:    qi(req.query.customerId, 0) || undefined,
        status:        qs(req.query.status),
        paymentStatus: qs(req.query.paymentStatus),
        channel:       qs(req.query.channel),
        dateFrom:      qs(req.query.dateFrom),
        dateTo:        qs(req.query.dateTo),
        page:          qi(req.query.page, 1),
        pageSize:      qi(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── GET /api/orders/:id ───────────────────────────────────────────────────────

router.get(
  '/orders/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await ordersService.getById(parseInt(req.params.id, 10));
      res.json(order);
    } catch (err) { next(err); }
  },
);

// ── POST /api/orders/:id/confirm ──────────────────────────────────────────────

router.post(
  '/orders/:id/confirm',
  authenticate,
  requireRole('Manager', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await ordersService.confirm(parseInt(req.params.id, 10), req.staff!);
      res.json(order);
    } catch (err) { next(err); }
  },
);

// ── POST /api/orders/:id/progress ─────────────────────────────────────────────

router.post(
  '/orders/:id/progress',
  authenticate,
  requireRole('Manager', 'Admin', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await ordersService.progress(parseInt(req.params.id, 10), req.staff!);
      res.json(order);
    } catch (err) { next(err); }
  },
);

// ── POST /api/orders/:id/fulfill ──────────────────────────────────────────────

router.post(
  '/orders/:id/fulfill',
  authenticate,
  requireRole('Manager', 'Admin', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await ordersService.fulfill(parseInt(req.params.id, 10), req.staff!);
      res.json(order);
    } catch (err) { next(err); }
  },
);

// ── POST /api/orders/:id/cancel ───────────────────────────────────────────────

router.post(
  '/orders/:id/cancel',
  authenticate,
  requireRole('Manager', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reason = req.body.reason ?? 'No reason provided';
      const order = await ordersService.cancel(parseInt(req.params.id, 10), reason, req.staff!);
      res.json(order);
    } catch (err) { next(err); }
  },
);

export default router;
