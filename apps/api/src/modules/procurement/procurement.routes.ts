import { Router, Request, Response, NextFunction } from 'express';
import * as procurementService from './procurement.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const qs = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? (v[0] as string | undefined) : undefined);
const qi = (v: unknown, fallback: number): number => { const s = qs(v); return s ? parseInt(s, 10) || fallback : fallback; };
const pi = (v: string | string[]): number => parseInt(Array.isArray(v) ? v[0] : v, 10);

// ── GET /api/purchase-orders ──────────────────────────────────────────────────

router.get(
  '/purchase-orders',
  authenticate,
  requireRole('Admin', 'Manager', 'Purchasor', 'Stock_Clerk', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await procurementService.list({
        branchId:   qi(req.query.branchId, 0) || undefined,
        status:     qs(req.query.status),
        supplierId: qi(req.query.supplierId, 0) || undefined,
        dateFrom:   qs(req.query.dateFrom),
        dateTo:     qs(req.query.dateTo),
        page:       qi(req.query.page, 1),
        pageSize:   qi(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── POST /api/purchase-orders ─────────────────────────────────────────────────

router.post(
  '/purchase-orders',
  authenticate,
  requireRole('Admin', 'Manager', 'Purchasor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await procurementService.createPO(
        { ...req.body, branchId: req.body.branchId ?? req.staff!.branchId },
        req.staff!,
      );
      res.status(201).json(po);
    } catch (err) { next(err); }
  },
);

// ── GET /api/purchase-orders/:id ──────────────────────────────────────────────

router.get(
  '/purchase-orders/:id',
  authenticate,
  requireRole('Admin', 'Manager', 'Purchasor', 'Stock_Clerk', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await procurementService.getById(pi(req.params.id));
      res.json(po);
    } catch (err) { next(err); }
  },
);

// ── PUT /api/purchase-orders/:id ──────────────────────────────────────────────

router.put(
  '/purchase-orders/:id',
  authenticate,
  requireRole('Admin', 'Manager', 'Purchasor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await procurementService.updatePO(pi(req.params.id), req.body, req.staff!);
      res.json(po);
    } catch (err) { next(err); }
  },
);

// ── POST /api/purchase-orders/:id/submit ──────────────────────────────────────

router.post(
  '/purchase-orders/:id/submit',
  authenticate,
  requireRole('Admin', 'Manager', 'Purchasor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await procurementService.submitForApproval(pi(req.params.id), req.staff!);
      res.json(po);
    } catch (err) { next(err); }
  },
);

// ── POST /api/purchase-orders/:id/approve ─────────────────────────────────────

router.post(
  '/purchase-orders/:id/approve',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await procurementService.approvePO(pi(req.params.id), req.staff!);
      res.json(po);
    } catch (err) { next(err); }
  },
);

// ── POST /api/purchase-orders/:id/order ───────────────────────────────────────

router.post(
  '/purchase-orders/:id/order',
  authenticate,
  requireRole('Admin', 'Manager', 'Purchasor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await procurementService.markAsOrdered(pi(req.params.id), req.staff!);
      res.json(po);
    } catch (err) { next(err); }
  },
);

// ── POST /api/purchase-orders/:id/receive ─────────────────────────────────────

router.post(
  '/purchase-orders/:id/receive',
  authenticate,
  requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { locationId, items, notes } = req.body as {
        locationId?: number | null;
        items: procurementService.ReceiveItemInput[];
        notes?: string;
      };
      const po = await procurementService.receivePO(
        pi(req.params.id),
        locationId ?? null,
        items,
        notes ?? null,
        req.staff!,
      );
      res.json(po);
    } catch (err) { next(err); }
  },
);

// ── POST /api/purchase-orders/:id/close ───────────────────────────────────────

router.post(
  '/purchase-orders/:id/close',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await procurementService.closePO(pi(req.params.id), req.staff!);
      res.json(po);
    } catch (err) { next(err); }
  },
);

// ── POST /api/purchase-orders/:id/cancel ──────────────────────────────────────

router.post(
  '/purchase-orders/:id/cancel',
  authenticate,
  requireRole('Admin', 'Manager', 'Purchasor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await procurementService.cancelPO(pi(req.params.id), req.staff!);
      res.json(po);
    } catch (err) { next(err); }
  },
);

export default router;
