import { Router, Request, Response, NextFunction } from 'express';
import * as reportsService from './reports.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import {
  buildCsv, sendCsv,
  SALES_COLUMNS, INVENTORY_COLUMNS, PROCUREMENT_COLUMNS, RECEIVABLES_COLUMNS,
  RETURN_COLUMNS, EXCHANGE_DETAIL_COLUMNS, PAYMENTS_LEDGER_COLUMNS,
  RECEIVABLES_AGING_COLUMNS, INVENTORY_VALUATION_COLUMNS,
  OPEN_POS_COLUMNS, SUPPLIER_BALANCES_COLUMNS, AP_AGING_COLUMNS,
  PURCHASES_BY_SUPPLIER_COLUMNS, PURCHASES_BY_BOOK_COLUMNS,
  SUPPLIER_PAYMENT_HISTORY_COLUMNS,
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

// ── GET /api/reports/sales/detail ─────────────────────────────────────────────
// On-screen detail view backing the same rows the export below streams —
// lets the frontend show the flat line-item table (with totals row) without
// downloading the CSV.

router.get(
  '/reports/sales/detail',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await reportsService.getSalesReportRows(parseFilters(req));
      res.json(result);
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/sales/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Prompt 2: sourced from getSalesReportRows() (reports.service.ts),
      // which itself wraps FinancialReportService's unified engine — the
      // same engine backing the Dashboard's Net Sales / Net Profit / Gross
      // Margin % cards, so CSV totals for a date range always reconcile
      // 1:1 with those cards for the same range. Covers all four channels
      // (ORDER/POS/RETURN/EXCHANGE), one row per line item; cancelled/
      // voided/rejected transactions are excluded automatically. A totals
      // row is appended so the CSV foots to the same figures on its own.
      const { rows, totals } = await reportsService.getSalesReportRows(parseFilters(req));
      const csvRows = rows.map(r => ({
        date: r.date,
        invoice_no: r.invoiceNo,
        source: r.source,
        customer: r.customer,
        book: r.book,
        qty: r.qty,
        unit_price: r.unitPrice,
        discount: r.discount,
        gross_amount: r.grossAmount,
        return_amount: r.returnAmount,
        net_sales_amount: r.netSalesAmount,
        cost_amount: r.costAmount,
        gross_profit: r.grossProfit,
        payment_status: r.paymentStatus,
        cash_collected: r.cashCollected,
        receivable_balance: r.receivableBalance,
        branch: r.branch,
        location: r.location,
        user: r.user,
      }));
      const totalsRow: Record<string, unknown> = {
        date: '', invoice_no: '', source: '', customer: 'TOTAL', book: '',
        qty: totals.qty, unit_price: '', discount: '',
        gross_amount: totals.grossAmount, return_amount: totals.returnAmount,
        net_sales_amount: totals.netSalesAmount, cost_amount: totals.costAmount,
        gross_profit: totals.grossProfit, payment_status: '',
        cash_collected: totals.cashCollected, receivable_balance: totals.receivableBalance,
        branch: '', location: '', user: '',
      };
      const allRows: Record<string, unknown>[] = [...csvRows, totalsRow];
      const today = new Date().toISOString().slice(0, 10);
      sendCsv(res, `sales-report-${today}.csv`, buildCsv(allRows, SALES_COLUMNS));
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/returns ───────────────────────────────────────────────────

router.get(
  '/reports/returns',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getReturnReportRows(parseFilters(req));
      res.json({ rows });
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/returns/top ────────────────────────────────────────────
// Prompt 2 — dashboard "Top Returned Books" widget.

router.get(
  '/reports/returns/top',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = qi(req.query.limit) ?? 10;
      const rows = await reportsService.getTopReturnedBooks(parseFilters(req), limit);
      res.json(rows);
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/sales/gross-profit-trend ───────────────────────────────
// Prompt 2 — dashboard "Gross Profit Trend" chart. Same underlying unified
// rows as the Sales Report/export, grouped by period.

router.get(
  '/reports/sales/gross-profit-trend',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const points = await reportsService.getGrossProfitTrend(parseFilters(req));
      res.json(points);
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/returns/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getReturnReportRows(parseFilters(req));
      const csvRows = rows.map(r => ({
        return_no: r.returnNo,
        original_invoice_no: r.originalInvoiceNo,
        customer: r.customer,
        book: r.book,
        qty_returned: r.qtyReturned,
        refund_amount: r.refundAmount,
        original_cost: r.originalCost,
        profit_reversed: r.profitReversed,
        refund_method: r.refundMethod,
        return_date: r.returnDate,
        user: r.user,
      }));
      const today = new Date().toISOString().slice(0, 10);
      sendCsv(res, `returns-report-${today}.csv`, buildCsv(csvRows, RETURN_COLUMNS));
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/exchanges/detail ──────────────────────────────────────────

router.get(
  '/reports/exchanges/detail',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getExchangeReportRows(parseFilters(req));
      res.json({ rows });
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/payments-ledger ───────────────────────────────────────────
// Unified bidirectional ledger (customer receipts IN + supplier payments
// OUT) — separate from /reports/payments, which stays as the dashboard's
// customer-only Payment Methods chart source.

router.get(
  '/reports/payments-ledger',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getPaymentsLedgerRows(parseFilters(req));
      res.json({ rows });
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/payments-ledger/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getPaymentsLedgerRows(parseFilters(req));
      const csvRows = rows.map(r => ({
        receipt_no: r.receiptNo,
        party: r.party,
        reference_type: r.referenceType,
        reference_no: r.referenceNo,
        payment_method: r.paymentMethod,
        amount: r.amount,
        direction: r.direction,
        date: r.date,
        user: r.user,
      }));
      const today = new Date().toISOString().slice(0, 10);
      sendCsv(res, `payments-ledger-${today}.csv`, buildCsv(csvRows, PAYMENTS_LEDGER_COLUMNS));
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/receivables-aging ─────────────────────────────────────────

router.get(
  '/reports/receivables-aging',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await reportsService.getReceivablesAgingReport(parseFilters(req));
      res.json(result);
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/receivables-aging/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await reportsService.getReceivablesAgingReport(parseFilters(req));
      const csvRows = rows.map(r => ({
        customer: r.customer,
        invoice_no: r.invoiceNo,
        invoice_date: r.invoiceDate,
        due_date: r.dueDate,
        outstanding_amount: r.outstandingAmount,
        aging_bucket: r.agingBucket,
        last_payment_date: r.lastPaymentDate,
      }));
      const today = new Date().toISOString().slice(0, 10);
      sendCsv(res, `receivables-aging-${today}.csv`, buildCsv(csvRows, RECEIVABLES_AGING_COLUMNS));
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/inventory-valuation/export ─────────────────────────────────

router.get(
  '/reports/inventory-valuation/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getInventoryExportRowsV2(parseFilters(req));
      const today = new Date().toISOString().slice(0, 10);
      sendCsv(res, `inventory-valuation-${today}.csv`, buildCsv(rows as unknown as Record<string, unknown>[], INVENTORY_VALUATION_COLUMNS));
    } catch (err) { next(err); }
  },
);

// ── GET /api/reports/kpis/period ────────────────────────────────────────────────
// Prompt 2 — Today/Week/Month/Year selector for the Sales Performance
// dashboard cards, with previous-period comparison.

router.get(
  '/reports/kpis/period',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawPeriod = qs(req.query.period);
      const period: reportsService.KpiPeriod =
        rawPeriod === 'today' || rawPeriod === 'week' || rawPeriod === 'month' || rawPeriod === 'year'
          ? rawPeriod : 'today';
      const branchId = qi(req.query.branchId) ?? req.staff?.branchId;
      const salesKpis = await reportsService.getPeriodSalesKpis(branchId, period);
      const [cashCollected, prevCashCollected] = await Promise.all([
        reportsService.getPeriodCashCollected(branchId, salesKpis.dateFrom, salesKpis.dateTo),
        reportsService.getPeriodCashCollected(branchId, salesKpis.previous.dateFrom, salesKpis.previous.dateTo),
      ]);
      res.json({ ...salesKpis, cashCollected, previousCashCollected: prevCashCollected });
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
      // Prompt 2: replaced the old byPeriod-only aggregate export with the
      // full per-exchange detail (Exchange No/Customer/Incoming/Outgoing/
      // Difference/Cash Collected/Receivable Balance/etc.) — the aggregate
      // byPeriod/bySettlementType view is still available on-screen via
      // GET /reports/exchanges for the dashboard's Exchange Activity panel.
      const rows = await reportsService.getExchangeReportRows(parseFilters(req));
      const csvRows = rows.map(r => ({
        exchange_no: r.exchangeNo,
        customer: r.customer,
        incoming_book: r.incomingBook,
        incoming_value: r.incomingValue,
        outgoing_book: r.outgoingBook,
        outgoing_value: r.outgoingValue,
        difference: r.difference,
        difference_payment_status: r.differencePaymentStatus,
        cash_collected: r.cashCollected,
        receivable_balance: r.receivableBalance,
        date: r.date,
        user: r.user,
      }));
      const today = new Date().toISOString().slice(0, 10);
      sendCsv(res, `exchanges-report-${today}.csv`, buildCsv(csvRows, EXCHANGE_DETAIL_COLUMNS));
    } catch (err) { next(err); }
  },
);

// ── Procurement reports (Prompt 2) ────────────────────────────────────────────

router.get(
  '/reports/procurement/open-pos',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try { res.json(await reportsService.getOpenPOs(parseFilters(req))); } catch (err) { next(err); }
  },
);
router.get(
  '/reports/procurement/open-pos/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getOpenPOs(parseFilters(req));
      const csvRows = rows.map(r => ({
        po_reference: r.poReference, supplier: r.supplier, order_date: r.orderDate, expected_date: r.expectedDate,
        ordered_qty: r.orderedQty, received_qty: r.receivedQty, total_amount: r.totalAmount,
        outstanding_amount: r.outstandingAmount, receipt_status: r.receiptStatus, payment_status: r.paymentStatus,
      }));
      sendCsv(res, `open-pos-${new Date().toISOString().slice(0,10)}.csv`, buildCsv(csvRows, OPEN_POS_COLUMNS));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/procurement/supplier-balances',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try { res.json(await reportsService.getSupplierBalances(parseFilters(req))); } catch (err) { next(err); }
  },
);
router.get(
  '/reports/procurement/supplier-balances/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getSupplierBalances(parseFilters(req));
      const csvRows = rows.map(r => ({
        supplier: r.supplier, open_po_count: r.openPoCount, received_value: r.receivedValue,
        paid: r.paid, credited: r.credited, outstanding_balance: r.outstandingBalance,
      }));
      sendCsv(res, `supplier-balances-${new Date().toISOString().slice(0,10)}.csv`, buildCsv(csvRows, SUPPLIER_BALANCES_COLUMNS));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/procurement/ap-aging',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try { res.json(await reportsService.getApAgingReport(parseFilters(req))); } catch (err) { next(err); }
  },
);
router.get(
  '/reports/procurement/ap-aging/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await reportsService.getApAgingReport(parseFilters(req));
      const csvRows = rows.map(r => ({
        supplier: r.supplier, po_reference: r.poReference, outstanding_amount: r.outstandingAmount,
        aging_bucket: r.agingBucket, last_receipt_date: r.lastReceiptDate,
      }));
      sendCsv(res, `ap-aging-${new Date().toISOString().slice(0,10)}.csv`, buildCsv(csvRows, AP_AGING_COLUMNS));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/procurement/purchases-by-supplier',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try { res.json(await reportsService.getPurchasesBySupplier(parseFilters(req))); } catch (err) { next(err); }
  },
);
router.get(
  '/reports/procurement/purchases-by-supplier/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getPurchasesBySupplier(parseFilters(req));
      const csvRows = rows.map(r => ({
        supplier: r.supplier, po_count: r.poCount, ordered_value: r.orderedValue, received_value: r.receivedValue,
      }));
      sendCsv(res, `purchases-by-supplier-${new Date().toISOString().slice(0,10)}.csv`, buildCsv(csvRows, PURCHASES_BY_SUPPLIER_COLUMNS));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/procurement/purchases-by-book',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try { res.json(await reportsService.getPurchasesByBook(parseFilters(req))); } catch (err) { next(err); }
  },
);
router.get(
  '/reports/procurement/purchases-by-book/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getPurchasesByBook(parseFilters(req));
      const csvRows = rows.map(r => ({
        title: r.title, isbn: r.isbn, ordered_qty: r.orderedQty, received_qty: r.receivedQty, total_value: r.totalValue,
      }));
      sendCsv(res, `purchases-by-book-${new Date().toISOString().slice(0,10)}.csv`, buildCsv(csvRows, PURCHASES_BY_BOOK_COLUMNS));
    } catch (err) { next(err); }
  },
);

router.get(
  '/reports/procurement/supplier-payment-history',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try { res.json(await reportsService.getSupplierPaymentHistory(parseFilters(req))); } catch (err) { next(err); }
  },
);
router.get(
  '/reports/procurement/supplier-payment-history/export',
  ...reportAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await reportsService.getSupplierPaymentHistory(parseFilters(req));
      const csvRows = rows.map(r => ({
        date: r.date, supplier: r.supplier, po_reference: r.poReference, amount: r.amount,
        payment_method: r.paymentMethod, source: r.source, user: r.user,
      }));
      sendCsv(res, `supplier-payment-history-${new Date().toISOString().slice(0,10)}.csv`, buildCsv(csvRows, SUPPLIER_PAYMENT_HISTORY_COLUMNS));
    } catch (err) { next(err); }
  },
);

export default router;
