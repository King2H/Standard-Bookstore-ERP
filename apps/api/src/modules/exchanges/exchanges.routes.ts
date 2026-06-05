import { Router, Request, Response, NextFunction } from 'express';
import * as exchangesService from './exchanges.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';
import { withIdempotency, hashBody } from '../../lib/idempotency.js';
import { computeExchangeAllowedActions } from './exchanges.service.js';
import type { Permission } from '../../lib/permissions.js';

const router = Router();
const qs = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const qi = (v: unknown, fb: number): number => { const s = qs(v); return s ? parseInt(s, 10) || fb : fb; };

// ── POST /api/exchanges ───────────────────────────────────────────────────────

router.post(
  '/exchanges',
  authenticate,
  requirePermission('CREATE_SALE'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { incomingItems, outgoingItems } = req.body;
      if ((!incomingItems || incomingItems.length === 0) && (!outgoingItems || outgoingItems.length === 0)) {
        throw new ValidationError('Exchange must have at least one incoming or outgoing item');
      }
      const body = {
        locationId:    req.body.locationId ?? null,
        customerId:    req.body.customerId ?? null,
        notes:         req.body.notes,
        incomingItems: incomingItems ?? [],
        outgoingItems: outgoingItems ?? [],
      };
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      if (idempotencyKey) {
        const { result, replayed } = await withIdempotency(
          idempotencyKey, '/exchanges', hashBody(body),
          () => exchangesService.createExchange(body, req.staff!),
        );
        if (replayed) res.setHeader('X-Idempotent-Replayed', 'true');
        res.status(replayed ? 200 : 201).json(result);
      } else {
        const exchange = await exchangesService.createExchange(body, req.staff!);
        res.status(201).json(exchange);
      }
    } catch (err) { next(err); }
  },
);

// ── POST /api/exchanges/initiate ──────────────────────────────────────────────

router.post(
  '/exchanges/initiate',
  authenticate,
  requirePermission('CREATE_SALE'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const exchange = await exchangesService.initiateExchange(req.body, req.staff!);
      const permissions = (req.staff!.permissions ?? []) as Permission[];
      res.status(201).json({
        ...exchange,
        allowedActions: computeExchangeAllowedActions(exchange.lifecycleStatus ?? null, exchange.status, permissions),
      });
    } catch (err) { next(err); }
  },
);

// ── GET /api/exchanges ────────────────────────────────────────────────────────

router.get(
  '/exchanges',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await exchangesService.list({
        branchId:   qi(req.query.branchId, 0) || undefined,
        customerId: qi(req.query.customerId, 0) || undefined,
        status:     qs(req.query.status),
        dateFrom:   qs(req.query.dateFrom),
        dateTo:     qs(req.query.dateTo),
        page:       qi(req.query.page, 1),
        pageSize:   qi(req.query.pageSize, 25),
      });
      const permissions = (req.staff?.permissions ?? []) as Permission[];
      const itemsWithActions = result.items.map(exchange => ({
        ...exchange,
        allowedActions: computeExchangeAllowedActions(exchange.lifecycleStatus ?? null, exchange.status, permissions),
      }));
      res.json({ ...result, items: itemsWithActions });
    } catch (err) { next(err); }
  },
);

// ── GET /api/exchanges/:id ────────────────────────────────────────────────────

router.get(
  '/exchanges/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const exchange = await exchangesService.getById(parseInt(req.params.id as string, 10));
      const permissions = (req.staff?.permissions ?? []) as Permission[];
      res.json({
        ...exchange,
        allowedActions: computeExchangeAllowedActions(exchange.lifecycleStatus ?? null, exchange.status, permissions),
      });
    } catch (err) { next(err); }
  },
);

// ── POST /api/exchanges/:id/review ────────────────────────────────────────────

router.post(
  '/exchanges/:id/review',
  authenticate,
  requirePermission('APPROVE_EXCHANGE'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const exchange = await exchangesService.reviewExchange(parseInt(req.params.id as string, 10), req.staff!);
      const permissions = (req.staff!.permissions ?? []) as Permission[];
      res.json({
        ...exchange,
        allowedActions: computeExchangeAllowedActions(exchange.lifecycleStatus ?? null, exchange.status, permissions),
      });
    } catch (err) { next(err); }
  },
);

// ── POST /api/exchanges/:id/approve ───────────────────────────────────────────

router.post(
  '/exchanges/:id/approve',
  authenticate,
  requirePermission('APPROVE_EXCHANGE'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const exchange = await exchangesService.approveExchange(parseInt(req.params.id as string, 10), req.staff!);
      const permissions = (req.staff!.permissions ?? []) as Permission[];
      res.json({
        ...exchange,
        allowedActions: computeExchangeAllowedActions(exchange.lifecycleStatus ?? null, exchange.status, permissions),
      });
    } catch (err) { next(err); }
  },
);

// ── POST /api/exchanges/:id/settle ────────────────────────────────────────────

router.post(
  '/exchanges/:id/settle',
  authenticate,
  requirePermission('APPROVE_EXCHANGE'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { entries, idempotencyKey, dueDate } = req.body as {
        entries: exchangesService.SettlementEntry[];
        idempotencyKey: string;
        dueDate?: string | null;
      };
      if (!entries || !Array.isArray(entries) || entries.length === 0) {
        throw new ValidationError('Settlement entries are required');
      }
      if (!idempotencyKey) {
        throw new ValidationError('idempotencyKey is required for settlement');
      }
      const exchange = await exchangesService.settleExchange(
        parseInt(req.params.id as string, 10),
        entries,
        idempotencyKey,
        req.staff!,
        dueDate,
      );
      const permissions = (req.staff!.permissions ?? []) as Permission[];
      res.json({
        ...exchange,
        allowedActions: computeExchangeAllowedActions(exchange.lifecycleStatus ?? null, exchange.status, permissions),
      });
    } catch (err) { next(err); }
  },
);

// ── POST /api/exchanges/:id/cancel ────────────────────────────────────────────

router.post(
  '/exchanges/:id/cancel',
  authenticate,
  requirePermission('APPROVE_EXCHANGE'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const exchange = await exchangesService.cancelExchange(parseInt(req.params.id as string, 10), req.staff!);
      res.json(exchange);
    } catch (err) { next(err); }
  },
);

export default router;
