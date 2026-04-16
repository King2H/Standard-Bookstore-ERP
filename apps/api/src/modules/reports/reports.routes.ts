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
    groupBy:  (groupBy === 'week' || groupBy === 'month' ? groupBy : 'day') as 'day' | 'week' | 'month',
  };
}

// All report endpoints require Manager or Admin
const reportAccess = [authenticate, requireRole('Manager', 'Admin')];

// ── CSV helper ────────────────────────────────────────────────────────────────

function toCSV(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [
    headers.join(','),
    ...rows.map(r => headers.map(h => escape(r[h])).join(',')),
  ];
  return lines.join('\r\n');
}

function sendCSV(res: Response, filename: string, data: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + data); // BOM for Excel compatibility
}

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

// ── CSV Export endpoints ──────────────────────────────────────────────────────
// GET /api/reports/:type/export?format=csv

router.get(
  '/reports/sales/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getSalesReport(parseFilters(req));
      const rows = report.byPeriod.map(r => ({
        period: r.period,
        total_sales_etb: r.totalSales.toFixed(2),
        total_orders: r.totalOrders,
        average_order_value_etb: r.averageOrderValue.toFixed(2),
      }));
      sendCSV(res, `sales-report-${new Date().toISOString().slice(0,10)}.csv`, toCSV(rows));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/payments/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getPaymentReport(parseFilters(req));
      const rows = [
        { metric: 'Total Collected (ETB)', value: report.summary.totalCollected.toFixed(2) },
        { metric: 'Total Refunded (ETB)', value: report.summary.totalRefunded.toFixed(2) },
        { metric: 'Net Collected (ETB)', value: report.summary.netCollected.toFixed(2) },
        { metric: 'Pending Payments (ETB)', value: report.summary.pendingPayments.toFixed(2) },
        ...report.byMethod.map(m => ({ metric: `Method: ${m.method}`, value: m.total.toFixed(2) })),
      ];
      sendCSV(res, `payments-report-${new Date().toISOString().slice(0,10)}.csv`, toCSV(rows));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/inventory/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getInventoryReport(parseFilters(req));
      const rows = report.topSellingBooks.map(b => ({
        book_id: b.bookId,
        title: b.title,
        units_sold: b.unitsSold,
        revenue_etb: b.revenue.toFixed(2),
      }));
      sendCSV(res, `inventory-report-${new Date().toISOString().slice(0,10)}.csv`, toCSV(rows));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/customers/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getCustomerReport(parseFilters(req));
      const rows = report.topCustomers.map(c => ({
        customer_id: c.customerId,
        full_name: c.fullName,
        total_spend_etb: c.totalSpend.toFixed(2),
        order_count: c.orderCount,
      }));
      sendCSV(res, `customers-report-${new Date().toISOString().slice(0,10)}.csv`, toCSV(rows));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/exchanges/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getExchangeReport(parseFilters(req));
      const rows = report.byPeriod.map(r => ({
        period: r.period,
        count: r.count,
        incoming_value_etb: r.incomingValue.toFixed(2),
        outgoing_value_etb: r.outgoingValue.toFixed(2),
      }));
      sendCSV(res, `exchanges-report-${new Date().toISOString().slice(0,10)}.csv`, toCSV(rows));
    } catch (err) { next(err); }
  },
);

export default router;
