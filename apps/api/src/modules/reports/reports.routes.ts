import { Router, Request, Response, NextFunction } from 'express';
import * as reportsService from './reports.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const qs = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const qi = (v: unknown): number | undefined => {
  const s = qs(v);
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return isNaN(n) ? undefined : n;
};

function parseFilters(req: Request) {
  const groupBy = qs(req.query.groupBy);
  return {
    branchId: qi(req.query.branchId),
    dateFrom: qs(req.query.dateFrom),
    dateTo:   qs(req.query.dateTo),
    groupBy:  (groupBy === 'week' || groupBy === 'month') ? groupBy : 'day' as const,
  };
}

// All report endpoints require Manager or Admin
const reportAccess = [authenticate, requireRole('Manager', 'Admin')];

// ── GET /api/reports/sales ────────────────────────────────────────────────────

router.get(
  '/reports/sales',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getSalesReport(parseFilters(req));
      res.json(report);
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/payments ─────────────────────────────────────────────────

router.get(
  '/reports/payments',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getPaymentReport(parseFilters(req));
      res.json(report);
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/exchanges ────────────────────────────────────────────────

router.get(
  '/reports/exchanges',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getExchangeReport(parseFilters(req));
      res.json(report);
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/inventory ────────────────────────────────────────────────

router.get(
  '/reports/inventory',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getInventoryReport(parseFilters(req));
      res.json(report);
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/customers ────────────────────────────────────────────────

router.get(
  '/reports/customers',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getCustomerReport(parseFilters(req));
      res.json(report);
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/kpis ─────────────────────────────────────────────────────

router.get(
  '/reports/kpis',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const kpis = await reportsService.getKpis(qi(req.query.branchId));
      res.json(kpis);
    } catch (err) { next(err); }
  },
);

export default router;
