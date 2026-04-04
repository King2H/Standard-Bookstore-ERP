import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as inventoryService from './inventory.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';

const router = Router();

const qs = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? (v[0] as string | undefined) : undefined);
const qi = (v: unknown, fallback: number): number => { const s = qs(v); return s ? parseInt(s, 10) || fallback : fallback; };
const qb = (v: unknown): boolean | undefined => { const s = qs(v); return s === undefined ? undefined : s === 'true'; };

// ── Validation schemas ────────────────────────────────────────────────────────

const adjustSchema = z.object({
  bookId:     z.number().int().positive(),
  locationId: z.number().int().positive(),
  delta:      z.number().int().refine(n => n !== 0, 'Delta cannot be zero'),
  reasonCode: z.enum(['damage', 'loss', 'return', 'correction']),
  notes:      z.string().max(500).optional(),
  version:    z.number().int().min(0),
});

const transferSchema = z.object({
  bookId:         z.number().int().positive(),
  fromLocationId: z.number().int().positive(),
  toLocationId:   z.number().int().positive(),
  quantity:       z.number().int().positive(),
  fromVersion:    z.number().int().min(0),
});

const reorderSchema = z.object({
  reorderPoint: z.number().int().min(0),
});

// ── GET /api/inventory — list stock for a branch ──────────────────────────────

router.get(
  '/inventory',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = req.staff!.branchId;
      const result = await inventoryService.listInventory({
        branchId,
        locationId: req.query.locationId ? qi(req.query.locationId, 0) : undefined,
        bookId:     req.query.bookId     ? qi(req.query.bookId, 0)     : undefined,
        lowStockOnly: qb(req.query.lowStockOnly),
        q:          qs(req.query.q),
        page:       qi(req.query.page, 1),
        pageSize:   qi(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── GET /api/inventory/low-stock ──────────────────────────────────────────────

router.get(
  '/inventory/low-stock',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await inventoryService.getLowStock(req.staff!.branchId);
      res.json({ items, total: items.length });
    } catch (err) { next(err); }
  },
);

// ── GET /api/inventory/history ────────────────────────────────────────────────

router.get(
  '/inventory/history',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await inventoryService.getInventoryHistory({
        branchId:     req.staff!.branchId,
        bookId:       req.query.bookId     ? qi(req.query.bookId, 0)     : undefined,
        locationId:   req.query.locationId ? qi(req.query.locationId, 0) : undefined,
        reasonCode:   qs(req.query.reasonCode) as inventoryService.ReasonCode | undefined,
        movementType: qs(req.query.movementType) as inventoryService.MovementType | undefined,
        dateFrom:     qs(req.query.dateFrom),
        dateTo:       qs(req.query.dateTo),
        page:         qi(req.query.page, 1),
        pageSize:     qi(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── POST /api/inventory/adjust ────────────────────────────────────────────────
// Admin, Manager, Stock_Clerk

router.post(
  '/inventory/adjust',
  authenticate,
  requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = adjustSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const row = await inventoryService.adjustStock({ ...parsed.data, staffCtx: req.staff! });
      res.json(row);
    } catch (err) { next(err); }
  },
);

// ── POST /api/inventory/transfer ──────────────────────────────────────────────
// Admin, Manager, Stock_Clerk

router.post(
  '/inventory/transfer',
  authenticate,
  requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = transferSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const result = await inventoryService.transferStock({ ...parsed.data, staffCtx: req.staff! });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── PUT /api/inventory/reorder-point ─────────────────────────────────────────
// Admin, Manager

router.put(
  '/inventory/reorder-point',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { bookId, locationId } = req.body as { bookId: number; locationId: number };
      const parsed = reorderSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const row = await inventoryService.setReorderPoint(bookId, locationId, parsed.data.reorderPoint, req.staff!);
      res.json(row);
    } catch (err) { next(err); }
  },
);

// ── POST /api/inventory/initialize ───────────────────────────────────────────
// Internal: called when a new book or location is created

router.post(
  '/inventory/initialize',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { bookId, locationId } = req.body as { bookId: number; locationId: number };
      await inventoryService.initializeInventory(bookId, locationId);
      res.json({ message: 'Inventory initialized' });
    } catch (err) { next(err); }
  },
);

// ── POST /api/inventory/stock-in ─────────────────────────────────────────────
// Manager, Stock_Clerk — incoming inventory (procurement, returns, etc.)

const stockInSchema = z.object({
  bookId:        z.number().int().positive(),
  locationId:    z.number().int().positive(),
  quantity:      z.number().int().positive(),
  version:       z.number().int().min(0),
  referenceType: z.enum(['purchase_order', 'return', 'adjustment', 'manual', 'initial_stock']).optional(),
  referenceId:   z.number().int().positive().optional(),
  notes:         z.string().max(500).optional(),
});

router.post(
  '/inventory/stock-in',
  authenticate,
  requireRole('Admin', 'Manager', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = stockInSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const row = await inventoryService.stockIn({ ...parsed.data, staffCtx: req.staff! });
      res.json(row);
    } catch (err) { next(err); }
  },
);

// ── POST /api/inventory/stock-out ─────────────────────────────────────────────
// Manager, Stock_Clerk, Sales — outgoing inventory (sales, orders, etc.)

const stockOutSchema = z.object({
  bookId:        z.number().int().positive(),
  locationId:    z.number().int().positive(),
  quantity:      z.number().int().positive(),
  version:       z.number().int().min(0),
  referenceType: z.string().max(50).optional(),
  referenceId:   z.number().int().positive().optional(),
  notes:         z.string().max(500).optional(),
});

router.post(
  '/inventory/stock-out',
  authenticate,
  requireRole('Admin', 'Manager', 'Stock_Clerk', 'Sales'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = stockOutSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', { issues: parsed.error.issues });
      const row = await inventoryService.stockOut({ ...parsed.data, staffCtx: req.staff! });
      res.json(row);
    } catch (err) { next(err); }
  },
);

export default router;
