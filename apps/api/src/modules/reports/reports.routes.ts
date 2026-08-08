import { Router, Request, Response, NextFunction } from 'express';
import * as reportsService from './reports.service.js';
import * as financialReportService from './financialReport.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import {
  buildCsv, sendCsv,
  SALES_COLUMNS, INVENTORY_COLUMNS, PROCUREMENT_COLUMNS, RECEIVABLES_COLUMNS,
} from '../../lib/csvBuilder.js';

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
  // If branchId is explicitly provided in query, use it.
  // Otherwise, for is_all_branches staff leave it undefined (all branches).
  // For regular staff, default to their assigned branch.
  const qBranchId = qi(req.query.branchId);
  const branchId = qBranchId ?? req.staff?.branchId;
  return {
    branchId,
    dateFrom: qs(req.query.dateFrom),
    dateTo:   qs(req.query.dateTo),
    groupBy:  (groupBy === 'week' || groupBy === 'month' ? groupBy : 'day') as 'day' | 'week' | 'month',
  };
}

// All report endpoints require VIEW_REPORTS permission
const reportAccess = [authenticate, requirePermission('VIEW_REPORTS')];

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

router.get(
  '/reports/sales/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Dashboard Standardization & Unified Reports Engine: sourced from
      // FinancialReportService (financialReport.service.ts) — the single
      // engine also backing the Dashboard's Net Sales Revenue / Net Profit
      // (unified) cards, so CSV totals for a date range always reconcile
      // 1:1 with those cards for the same range. Covers all four channels
      // (ORDER/POS/RETURN/EXCHANGE), one row per line item; cancelled/voided/
      // rejected transactions are excluded automatically.
      const rows = await financialReportService.getUnifiedTransactionRows(parseFilters(req));
      const csvRows = rows.map(r => ({
        transaction_date: r.transactionDate,
        transaction_type: r.transactionType,
        reference_number: r.referenceNumber,
        branch: r.branch,
        customer_name: r.customerName,
        book_title: r.bookTitle,
        book_isbn: r.bookIsbn,
        quantity: r.quantity,
        unit_price: r.unitPrice,
        discount_amount: r.discountAmount,
        gross_amount: r.grossAmount,
        net_amount: r.netAmount,
        payment_status: r.paymentStatus,
        payment_method: r.paymentMethod,
      }));
      const today = new Date().toISOString().slice(0, 10);
      sendCsv(res, `sales-report-${today}.csv`, buildCsv(csvRows, SALES_COLUMNS));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/payments/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getPaymentReport(parseFilters(req));
      const today = new Date().toISOString().slice(0, 10);
      const rows: Record<string, unknown>[] = [
        { metric: 'Total Collected',  amount: report.summary.totalCollected  },
        { metric: 'Total Refunded',   amount: report.summary.totalRefunded   },
        { metric: 'Net Collected',    amount: report.summary.netCollected    },
        { metric: 'Pending Payments', amount: report.summary.pendingPayments },
        ...report.byMethod.map(m => ({ metric: `Method: ${m.method}`, amount: m.total })),
      ];
      const cols = [
        { key: 'metric', header: 'metric', type: 'string' as const },
        { key: 'amount', header: 'amount', type: 'number' as const },
      ];
      sendCsv(res, `payments-report-${today}.csv`, buildCsv(rows, cols));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/inventory/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getInventoryExportRowsV2(parseFilters(req));
      const today = new Date().toISOString().slice(0, 10);
      sendCsv(res, `inventory-export-${today}.csv`, buildCsv(rows as unknown as Record<string, unknown>[], INVENTORY_COLUMNS));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/procurement/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getProcurementExportRows(parseFilters(req));
      const today = new Date().toISOString().slice(0, 10);
      sendCsv(res, `procurement-report-${today}.csv`, buildCsv(rows as unknown as Record<string, unknown>[], PROCUREMENT_COLUMNS));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/receivables/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getReceivablesExportRows(parseFilters(req));
      const today = new Date().toISOString().slice(0, 10);
      sendCsv(res, `receivables-report-${today}.csv`, buildCsv(rows as unknown as Record<string, unknown>[], RECEIVABLES_COLUMNS));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/customers/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getCustomerReport(parseFilters(req));
      const today = new Date().toISOString().slice(0, 10);
      const rows = report.topCustomers.map(c => ({
        customer_id:  c.customerId,
        full_name:    c.fullName,
        total_spend:  c.totalSpend,
        order_count:  c.orderCount,
      }));
      const cols = [
        { key: 'customer_id',  header: 'customer_id',  type: 'integer' as const },
        { key: 'full_name',    header: 'full_name',     type: 'string'  as const },
        { key: 'total_spend',  header: 'total_spend',   type: 'number'  as const },
        { key: 'order_count',  header: 'order_count',   type: 'integer' as const },
      ];
      sendCsv(res, `customers-report-${today}.csv`, buildCsv(rows as Record<string, unknown>[], cols));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/exchanges/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await reportsService.getExchangeReport(parseFilters(req));
      const today = new Date().toISOString().slice(0, 10);
      const rows = report.byPeriod.map(r => ({
        period:          r.period,
        count:           r.count,
        incoming_value:  r.incomingValue,
        outgoing_value:  r.outgoingValue,
      }));
      const cols = [
        { key: 'period',         header: 'period',         type: 'string'  as const },
        { key: 'count',          header: 'count',           type: 'integer' as const },
        { key: 'incoming_value', header: 'incoming_value',  type: 'number'  as const },
        { key: 'outgoing_value', header: 'outgoing_value',  type: 'number'  as const },
      ];
      sendCsv(res, `exchanges-report-${today}.csv`, buildCsv(rows as Record<string, unknown>[], cols));
    } catch (err) { next(err); }
  },
);

export default router;
