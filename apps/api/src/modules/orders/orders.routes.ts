import { Router, Request, Response, NextFunction } from 'express';
import * as ordersService from './orders.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole, requirePermission } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';
import { withIdempotency, hashBody } from '../../lib/idempotency.js';
import { computeOrderAllowedActions } from './orders.service.js';
import { Permission } from '../../lib/permissions.js';
import { paramInt } from '../../lib/http.js';

const router = Router();
const qs = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const qi = (v: unknown, fb: number): number => { const s = qs(v); return s ? parseInt(s, 10) || fb : fb; };

// â”€â”€ POST /api/orders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.post(
  '/orders',
  authenticate,
  requirePermission('CREATE_SALE'),
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
        saleType:   req.body.saleType ?? 'cash_sale',
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

// â”€â”€ GET /api/orders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
      const permissions = (req.staff!.permissions ?? []) as Permission[];
      const itemsWithActions = result.items.map(order => ({
        ...order,
        allowedActions: computeOrderAllowedActions(order.status, permissions, order.paymentStatus, order.saleType),
      }));
      res.json({ ...result, items: itemsWithActions });
    } catch (err) { next(err); }
  },
);

// â”€â”€ GET /api/orders/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get(
  '/orders/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await ordersService.getById(paramInt(req.params.id));
      const permissions = (req.staff!.permissions ?? []) as Permission[];
      res.json({ ...order, allowedActions: computeOrderAllowedActions(order.status, permissions, order.paymentStatus, order.saleType) });
    } catch (err) { next(err); }
  },
);

// â”€â”€ POST /api/orders/:id/confirm â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.post(
  '/orders/:id/confirm',
  authenticate,
  requirePermission('CREATE_SALE'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dueDate = typeof req.body?.dueDate === 'string' ? req.body.dueDate : null;
      const paymentMethod = typeof req.body?.paymentMethod === 'string' ? req.body.paymentMethod : null;
      const order = await ordersService.confirm(paramInt(req.params.id), req.staff!, dueDate, paymentMethod);
      const permissions = (req.staff!.permissions ?? []) as Permission[];
      res.json({ ...order, allowedActions: computeOrderAllowedActions(order.status, permissions, order.paymentStatus, order.saleType) });
    } catch (err) { next(err); }
  },
);

// ── DELETE /api/orders/:id ────────────────────────────────────────────────────
// Module 9: admin-only cleanup for Draft/Cancelled orders. Service layer
// enforces the status gate and dependency checks — see orders.service.ts
// deleteOrder().

router.delete(
  '/orders/:id',
  authenticate,
  requireRole('Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await ordersService.deleteOrder(paramInt(req.params.id), req.staff!);
      res.json({ message: 'Order deleted' });
    } catch (err) { next(err); }
  },
);

// â”€â”€ POST /api/orders/:id/progress â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.post(
  '/orders/:id/progress',
  authenticate,
  requireRole('Manager', 'Admin', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await ordersService.progress(paramInt(req.params.id), req.staff!);
      res.json(order);
    } catch (err) { next(err); }
  },
);

// â”€â”€ POST /api/orders/:id/pay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// ── POST /api/orders/:id/pay  [DEPRECATED — use POST /api/payments instead] ──

router.post(
  '/orders/:id/pay',
  authenticate,
  requirePermission('PROCESS_PAYMENT'),
  (_req: Request, res: Response) => {
    res.status(410).json({
      error: 'DEPRECATED',
      message:
        'POST /orders/:id/pay is no longer supported. ' +
        'Use POST /payments to record payments against an order.',
    });
  },
);

// â”€â”€ POST /api/orders/:id/fulfill â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.post(
  '/orders/:id/fulfill',
  authenticate,
  requirePermission('PROCESS_PAYMENT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await ordersService.fulfill(paramInt(req.params.id), req.staff!);
      const permissions = (req.staff!.permissions ?? []) as Permission[];
      res.json({ ...order, allowedActions: computeOrderAllowedActions(order.status, permissions, order.paymentStatus, order.saleType) });
    } catch (err) { next(err); }
  },
);

// â”€â”€ POST /api/orders/:id/cancel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.post(
  '/orders/:id/cancel',
  authenticate,
  requirePermission('CREATE_SALE'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reason = req.body.reason ?? 'No reason provided';
      const order = await ordersService.cancel(paramInt(req.params.id), reason, req.staff!);
      const permissions = (req.staff!.permissions ?? []) as Permission[];
      res.json({ ...order, allowedActions: computeOrderAllowedActions(order.status, permissions, order.paymentStatus, order.saleType) });
    } catch (err) { next(err); }
  },
);

// ── POST /api/orders/:id/collect-payment ─────────────────────────────────────

router.post(
  '/orders/:id/collect-payment',
  authenticate,
  requireRole('Admin', 'Manager', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const amount = req.body.amount;
      if (typeof amount !== 'number' || amount <= 0) {
        throw new ValidationError('amount must be a positive number');
      }
      const order = await ordersService.collectPayment(
        paramInt(req.params.id),
        amount,
        req.staff!,
      );
      const permissions = (req.staff!.permissions ?? []) as Permission[];
      res.json({
        ...order,
        allowedActions: computeOrderAllowedActions(order.status, permissions, order.paymentStatus, order.saleType),
      });
    } catch (err) { next(err); }
  },
);

export default router;
