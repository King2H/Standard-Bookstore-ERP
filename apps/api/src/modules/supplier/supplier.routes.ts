import { Router, Request, Response, NextFunction } from 'express';
import * as supplierService from './supplier.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { paramInt } from '../../lib/http.js';

const router = Router();

const qs = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? (v[0] as string | undefined) : undefined);
const qi = (v: unknown, fallback: number): number => { const s = qs(v); return s ? parseInt(s, 10) || fallback : fallback; };
const qb = (v: unknown): boolean | undefined => { const s = qs(v); return s === undefined ? undefined : s === 'true'; };
// Bug Sweep: was a bare parseInt() with no NaN guard — see customer.routes.ts's comment.
const pi = paramInt;

// ── GET /api/suppliers ────────────────────────────────────────────────────────

router.get(
  '/suppliers',
  authenticate,
  requireRole('Admin', 'Manager', 'Purchasor', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await supplierService.list({
        supplierType: qs(req.query.supplierType),
        isActive:     qb(req.query.isActive),
        isBlacklisted: qb(req.query.isBlacklisted),
        q:            qs(req.query.q),
        page:         qi(req.query.page, 1),
        pageSize:     qi(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── POST /api/suppliers ───────────────────────────────────────────────────────

router.post(
  '/suppliers',
  authenticate,
  requireRole('Admin', 'Manager', 'Purchasor', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const supplier = await supplierService.create(req.body, req.staff!);
      res.status(201).json(supplier);
    } catch (err) { next(err); }
  },
);

// ── GET /api/suppliers/:id ────────────────────────────────────────────────────

router.get(
  '/suppliers/:id',
  authenticate,
  requireRole('Admin', 'Manager', 'Purchasor', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const supplier = await supplierService.getById(pi(req.params.id));
      res.json(supplier);
    } catch (err) { next(err); }
  },
);

// ── PUT /api/suppliers/:id ────────────────────────────────────────────────────

router.put(
  '/suppliers/:id',
  authenticate,
  requireRole('Admin', 'Manager', 'Purchasor', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const supplier = await supplierService.update(pi(req.params.id), req.body, req.staff!);
      res.json(supplier);
    } catch (err) { next(err); }
  },
);

// ── POST /api/suppliers/:id/deactivate ────────────────────────────────────────

router.post(
  '/suppliers/:id/deactivate',
  authenticate,
  requireRole('Admin', 'Manager', 'Purchasor', 'Stock_Clerk'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await supplierService.deactivate(pi(req.params.id), req.staff!);
      res.json({ message: 'Supplier deactivated' });
    } catch (err) { next(err); }
  },
);

// ── POST /api/suppliers/:id/blacklist ─────────────────────────────────────────

router.post(
  '/suppliers/:id/blacklist',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await supplierService.blacklist(pi(req.params.id), req.staff!);
      res.json({ message: 'Supplier blacklisted' });
    } catch (err) { next(err); }
  },
);

// ── DELETE /api/suppliers/:id ─────────────────────────────────────────────────

router.delete(
  '/suppliers/:id',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await supplierService.deleteSupplier(pi(req.params.id), req.staff!);
      res.json({ message: 'Supplier deleted' });
    } catch (err) { next(err); }
  },
);

// ── GET /api/books/:bookId/suppliers ──────────────────────────────────────────

router.get(
  '/books/:bookId/suppliers',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await supplierService.getSuppliersForBook(pi(req.params.bookId));
      res.json({ items });
    } catch (err) { next(err); }
  },
);

// ── POST /api/books/:bookId/suppliers ─────────────────────────────────────────

router.post(
  '/books/:bookId/suppliers',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { supplierId, supplierSku, isPrimary } = req.body as {
        supplierId: number;
        supplierSku?: string;
        isPrimary?: boolean;
      };
      await supplierService.linkBookToSupplier(
        pi(req.params.bookId),
        supplierId,
        supplierSku ?? null,
        isPrimary ?? false,
        req.staff!,
      );
      res.status(201).json({ message: 'Supplier linked to book' });
    } catch (err) { next(err); }
  },
);

// ── DELETE /api/books/:bookId/suppliers/:supplierId ───────────────────────────

router.delete(
  '/books/:bookId/suppliers/:supplierId',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await supplierService.unlinkBookFromSupplier(
        pi(req.params.bookId),
        pi(req.params.supplierId),
        req.staff!,
      );
      res.json({ message: 'Supplier unlinked from book' });
    } catch (err) { next(err); }
  },
);

export default router;
