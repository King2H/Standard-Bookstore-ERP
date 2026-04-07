import { Router, Request, Response, NextFunction } from 'express';
import * as exchangesService from './exchanges.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';

const router = Router();
const qs = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const qi = (v: unknown, fb: number): number => { const s = qs(v); return s ? parseInt(s, 10) || fb : fb; };

// ── POST /api/exchanges ───────────────────────────────────────────────────────

router.post(
  '/exchanges',
  authenticate,
  requireRole('Sales', 'Manager', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { incomingItems, outgoingItems } = req.body;
      if ((!incomingItems || incomingItems.length === 0) && (!outgoingItems || outgoingItems.length === 0)) {
        throw new ValidationError('Exchange must have at least one incoming or outgoing item');
      }
      const exchange = await exchangesService.createExchange(
        {
          locationId:    req.body.locationId ?? null,
          customerId:    req.body.customerId ?? null,
          notes:         req.body.notes,
          incomingItems: incomingItems ?? [],
          outgoingItems: outgoingItems ?? [],
        },
        req.staff!,
      );
      res.status(201).json(exchange);
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
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── GET /api/exchanges/:id ────────────────────────────────────────────────────

router.get(
  '/exchanges/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const exchange = await exchangesService.getById(parseInt(req.params.id, 10));
      res.json(exchange);
    } catch (err) { next(err); }
  },
);

// ── POST /api/exchanges/:id/cancel ────────────────────────────────────────────

router.post(
  '/exchanges/:id/cancel',
  authenticate,
  requireRole('Manager', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const exchange = await exchangesService.cancelExchange(parseInt(req.params.id, 10), req.staff!);
      res.json(exchange);
    } catch (err) { next(err); }
  },
);

export default router;
