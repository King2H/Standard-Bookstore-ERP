import type { AgingBucket } from '@bms/shared';
import { db } from '../../db/index.js';
import { costBasisLateralJoin } from '../../lib/costBasis.js';
import { agingBucket as bucketForDaysOverdue } from './receivables/receivableReports.policy.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReportFilters {
  branchId?: number;
  dateFrom?: string;
  dateTo?: string;
  groupBy?: 'day' | 'week' | 'month';
}

export interface PaymentReport {
  summary: {
    totalCollected: number;
    totalRefunded: number;
    netCollected: number;
    pendingPayments: number;
  };
  byMethod: Array<{ method: string; total: number; count: number }>;
  byPeriod: Array<{ period: string; collected: number; refunded: number }>;
}

export interface ExchangeReport {
  summary: {
    totalExchanges: number;
    totalIncomingValue: number;
    totalOutgoingValue: number;
    netExchangeImpact: number;
  };
  bySettlementType: Array<{ settlementType: string; count: number; totalNetBalance: number }>;
  byPeriod: Array<{ period: string; count: number; incomingValue: number; outgoingValue: number }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const round2 = (n: number): number => parseFloat(n.toFixed(2));

function buildDateConditions(
  filters: ReportFilters,
  tableAlias = '',
  colName = 'created_at',
): { conditions: string[]; params: unknown[] } {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.branchId) {
    params.push(filters.branchId);
    conditions.push(`${prefix}branch_id = $${params.length}`);
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    // Cast to date so the comparison works regardless of timezone/time component
    conditions.push(`${prefix}${colName}::date >= $${params.length}::date`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    // Inclusive end: use ::date so the full dateTo day is included
    conditions.push(`${prefix}${colName}::date <= $${params.length}::date`);
  }
  return { conditions, params };
}
// ── Payment Report ────────────────────────────────────────────────────────────

export async function getPaymentReport(filters: ReportFilters): Promise<PaymentReport> {
  const groupBy = filters.groupBy ?? 'day';
  const truncExpr = `date_trunc('${groupBy}', op.processed_at)`;

  // Build conditions — order_payments doesn't have branch_id directly; join via orders
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filters.branchId) {
    params.push(filters.branchId);
    conditions.push(`o.branch_id = $${params.length}`);
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    // Cast to date — matches the ::date convention every other report uses,
    // so a dateTo of e.g. 2026-08-12 includes the whole day regardless of
    // timezone/time component (this previously compared raw timestamps).
    conditions.push(`op.processed_at::date >= $${params.length}::date`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    conditions.push(`op.processed_at::date <= $${params.length}::date`);
  }
  const joinClause = filters.branchId ? 'JOIN orders o ON o.id = op.order_id' : '';
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const summaryRes = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN op.status IN ('success','partially_refunded') THEN op.amount ELSE 0 END), 0)::NUMERIC AS total_collected,
       COALESCE(SUM(CASE WHEN op.status = 'pending' THEN op.amount ELSE 0 END), 0)::NUMERIC                        AS pending_payments
     FROM order_payments op ${joinClause} ${where}`,
    params,
  );

  const refundRes = await db.query(
    `SELECT COALESCE(SUM(r.refund_amount), 0)::NUMERIC AS total_refunded
     FROM order_refunds r
     JOIN order_payments op ON op.id = r.payment_id
     ${joinClause.replace('op.order_id', 'op.order_id')} ${where}`,
    params,
  );

  const byMethodRes = await db.query(
    `SELECT
       op.payment_method                                                                                              AS method,
       COALESCE(SUM(CASE WHEN op.status IN ('success','partially_refunded') THEN op.amount ELSE 0 END), 0)::NUMERIC AS total,
       COUNT(*)::INTEGER                                                                                             AS count
     FROM order_payments op ${joinClause} ${where}
     GROUP BY op.payment_method
     ORDER BY total DESC`,
    params,
  );

  const byPeriodRes = await db.query(
    `SELECT
       ${truncExpr}::TEXT                                                                                             AS period,
       COALESCE(SUM(CASE WHEN op.status IN ('success','partially_refunded') THEN op.amount ELSE 0 END), 0)::NUMERIC AS collected,
       0::NUMERIC                                                                                                    AS refunded
     FROM order_payments op ${joinClause} ${where}
     GROUP BY ${truncExpr}
     ORDER BY ${truncExpr}`,
    params,
  );

  // ── Exchange settlement cash entries ──────────────────────────────────────
  // Module 2: exchange settlement (settleExchange()) records cash_payment/
  // cash_refund entries into financial_transactions, but this report only
  // ever queried order_payments -- exchange money movement was invisible in
  // the Payments report (and had no other surface anywhere in the app).
  // financial_transactions has branch_id directly (no join needed) and its
  // own created_at column, so it needs its own filter param set.
  const exParams: unknown[] = [];
  const exConditions: string[] = ['ft.exchange_id IS NOT NULL', `ft.type IN ('payment','refund')`];
  if (filters.branchId) { exParams.push(filters.branchId); exConditions.push(`ft.branch_id = $${exParams.length}`); }
  if (filters.dateFrom) { exParams.push(filters.dateFrom); exConditions.push(`ft.created_at::date >= $${exParams.length}::date`); }
  if (filters.dateTo)   { exParams.push(filters.dateTo);   exConditions.push(`ft.created_at::date <= $${exParams.length}::date`); }
  const exWhere = 'WHERE ' + exConditions.join(' AND ');
  const exTruncExpr = `date_trunc('${groupBy}', ft.created_at)`;

  const [exSummaryRes, exByMethodRes, exByPeriodRes] = await Promise.all([
    db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN ft.type = 'payment' THEN ft.amount ELSE 0 END), 0)::NUMERIC AS collected,
         COALESCE(SUM(CASE WHEN ft.type = 'refund'  THEN ft.amount ELSE 0 END), 0)::NUMERIC AS refunded
       FROM financial_transactions ft ${exWhere}`,
      exParams,
    ),
    db.query(
      `SELECT COALESCE(ft.method, 'cash') AS method,
              COALESCE(SUM(CASE WHEN ft.type = 'payment' THEN ft.amount ELSE 0 END), 0)::NUMERIC AS total,
              COUNT(*) FILTER (WHERE ft.type = 'payment')::INTEGER AS count
       FROM financial_transactions ft ${exWhere}
       GROUP BY COALESCE(ft.method, 'cash')`,
      exParams,
    ),
    db.query(
      `SELECT ${exTruncExpr}::TEXT AS period,
              COALESCE(SUM(CASE WHEN ft.type = 'payment' THEN ft.amount ELSE 0 END), 0)::NUMERIC AS collected,
              COALESCE(SUM(CASE WHEN ft.type = 'refund'  THEN ft.amount ELSE 0 END), 0)::NUMERIC AS refunded
       FROM financial_transactions ft ${exWhere}
       GROUP BY ${exTruncExpr}`,
      exParams,
    ),
  ]);

  const s = summaryRes.rows[0];
  const totalRefunded = parseFloat(refundRes.rows[0].total_refunded);
  const exCollected = parseFloat(exSummaryRes.rows[0].collected);
  const exRefunded = parseFloat(exSummaryRes.rows[0].refunded);

  const byMethodMerged: Record<string, { method: string; total: number; count: number }> = {};
  for (const r of byMethodRes.rows) {
    const rawMethod = r.method as string;
    const method = rawMethod === 'store_credit' || rawMethod === 'mobile' ? 'Telebirr' : rawMethod;
    const total = parseFloat(r.total as string);
    const count = parseInt(r.count as string, 10);
    if (byMethodMerged[method]) {
      byMethodMerged[method].total += total;
      byMethodMerged[method].count += count;
    } else {
      byMethodMerged[method] = { method, total, count };
    }
  }
  for (const r of exByMethodRes.rows) {
    const total = parseFloat(r.total as string);
    if (total <= 0) continue; // method rows with only refunds contribute nothing to "collected"
    const method = r.method as string;
    if (byMethodMerged[method]) {
      byMethodMerged[method].total += total;
      byMethodMerged[method].count += parseInt(r.count as string, 10);
    } else {
      byMethodMerged[method] = { method, total, count: parseInt(r.count as string, 10) };
    }
  }

  const byPeriodMerged = new Map<string, { period: string; collected: number; refunded: number }>();
  for (const r of byPeriodRes.rows) {
    byPeriodMerged.set(r.period as string, { period: r.period as string, collected: parseFloat(r.collected as string), refunded: parseFloat(r.refunded as string) });
  }
  for (const r of exByPeriodRes.rows) {
    const period = r.period as string;
    const existing = byPeriodMerged.get(period);
    if (existing) {
      existing.collected += parseFloat(r.collected as string);
      existing.refunded += parseFloat(r.refunded as string);
    } else {
      byPeriodMerged.set(period, { period, collected: parseFloat(r.collected as string), refunded: parseFloat(r.refunded as string) });
    }
  }

  return {
    summary: {
      totalCollected:  parseFloat(s.total_collected) + exCollected,
      totalRefunded:   totalRefunded + exRefunded,
      netCollected:    parseFloat(s.total_collected) + exCollected - (totalRefunded + exRefunded),
      pendingPayments: parseFloat(s.pending_payments),
    },
    byMethod: Object.values(byMethodMerged).sort((a, b) => b.total - a.total),
    byPeriod: Array.from(byPeriodMerged.values()).sort((a, b) => a.period.localeCompare(b.period)),
  };
}

// ── Exchange Report ───────────────────────────────────────────────────────────

export async function getExchangeReport(filters: ReportFilters): Promise<ExchangeReport> {
  const groupBy = filters.groupBy ?? 'day';
  const truncExpr = `date_trunc('${groupBy}', e.created_at)`;

  const { conditions, params } = buildDateConditions(filters, 'e');
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const summaryRes = await db.query(
    `SELECT
       COUNT(*)::INTEGER                              AS total_exchanges,
       COALESCE(SUM(e.total_incoming_value), 0)::NUMERIC AS total_incoming,
       COALESCE(SUM(e.total_outgoing_value), 0)::NUMERIC AS total_outgoing,
       COALESCE(SUM(e.net_balance), 0)::NUMERIC          AS net_impact
     FROM exchanges e ${where}`,
    params,
  );

  const bySettlementRes = await db.query(
    `SELECT
       e.settlement_type,
       COUNT(*)::INTEGER                         AS count,
       COALESCE(SUM(e.net_balance), 0)::NUMERIC  AS total_net_balance
     FROM exchanges e ${where}
     GROUP BY e.settlement_type
     ORDER BY count DESC`,
    params,
  );

  const byPeriodRes = await db.query(
    `SELECT
       ${truncExpr}::TEXT                                     AS period,
       COUNT(*)::INTEGER                                      AS count,
       COALESCE(SUM(e.total_incoming_value), 0)::NUMERIC     AS incoming_value,
       COALESCE(SUM(e.total_outgoing_value), 0)::NUMERIC     AS outgoing_value
     FROM exchanges e ${where}
     GROUP BY ${truncExpr}
     ORDER BY ${truncExpr}`,
    params,
  );

  const s = summaryRes.rows[0];

  return {
    summary: {
      totalExchanges:     s.total_exchanges,
      totalIncomingValue: parseFloat(s.total_incoming),
      totalOutgoingValue: parseFloat(s.total_outgoing),
      netExchangeImpact:  parseFloat(s.net_impact),
    },
    bySettlementType: bySettlementRes.rows.map(r => ({
      settlementType:  r.settlement_type,
      count:           r.count,
      totalNetBalance: parseFloat(r.total_net_balance),
    })),
    byPeriod: byPeriodRes.rows.map(r => ({
      period:        r.period,
      count:         r.count,
      incomingValue: parseFloat(r.incoming_value),
      outgoingValue: parseFloat(r.outgoing_value),
    })),
  };
}

// ── Procurement Export Rows ───────────────────────────────────────────────────

export interface ProcurementExportRow {
  po_reference: string;
  date: string;
  supplier_name: string;
  status: string;
  book_code: string;
  title: string;
  ordered_quantity: number;
  received_quantity: number;
  unit_cost: number;
  line_total: number;
  po_total: number;
}

export async function getProcurementExportRows(filters: ReportFilters): Promise<ProcurementExportRow[]> {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filters.branchId) { params.push(filters.branchId); conditions.push(`po.branch_id = $${params.length}`); }
  if (filters.dateFrom) { params.push(filters.dateFrom); conditions.push(`po.created_at::date >= $${params.length}::date`); }
  if (filters.dateTo)   { params.push(filters.dateTo);   conditions.push(`po.created_at::date <= $${params.length}::date`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const res = await db.query(
    `SELECT
       po.id AS po_id,
       TO_CHAR(po.created_at, 'YYYY-MM-DD') AS date_str,
       s.name AS supplier_name,
       po.status,
       po.total_amount,
       COALESCE(b.sku, b.isbn) AS book_code,
       b.title,
       pli.quantity      AS ordered_quantity,
       pli.received_quantity,
       pli.unit_cost,
       (pli.unit_cost * pli.quantity)::NUMERIC AS line_total
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN po_line_items pli ON pli.po_id = po.id
     JOIN books b ON b.id = pli.book_id
     ${where}
     ORDER BY po.created_at DESC, po.id, b.title`,
    params,
  );

  return (res.rows as Record<string, unknown>[]).map(row => ({
    po_reference:      String(row.po_id),
    // TO_CHAR(...) SQL-side string — never a JS Date/toISOString() round-trip
    // (that pattern drifts a day off near midnight in non-UTC timezones).
    date:              row.date_str as string,
    supplier_name:     row.supplier_name as string,
    status:            row.status as string,
    book_code:         (row.book_code as string | null) ?? '',
    title:             row.title as string,
    ordered_quantity:  row.ordered_quantity as number,
    received_quantity: row.received_quantity as number,
    unit_cost:         parseFloat(row.unit_cost as string),
    line_total:        parseFloat(row.line_total as string),
    po_total:          parseFloat(row.total_amount as string),
  }));
}

// ── Return Report (Prompt 2) ────────────────────────────────────────────────
// Genuinely new — returns previously only appeared embedded inside the
// unified Sales rows. Enabled cleanly by Prompt 1's persisted per-line
// unit_cost: "Original Cost" and "Profit Reversed" are computed straight
// from the ORIGINAL sale's frozen cost (via transaction_line_item_id, the
// same link returns.service.ts itself resolves inventory restoration
// against), never the current average.

export interface ReturnReportRow {
  returnNo: string;
  originalInvoiceNo: string;
  customer: string;
  book: string;
  qtyReturned: number;
  refundAmount: number;
  originalCost: number;
  profitReversed: number;   // positive magnitude — the original margin now given back
  refundMethod: string;
  returnDate: string;
  user: string;
}

export async function getReturnReportRows(filters: ReportFilters): Promise<ReturnReportRow[]> {
  const { conditions, params } = buildDateConditions(filters, 'r');
  const where = 'WHERE ' + [...conditions, `r.status = 'completed'`].join(' AND ');

  const res = await db.query(
    `SELECT
       TO_CHAR(r.created_at, 'YYYY-MM-DD') AS return_date,
       r.return_number, t.transaction_number AS original_invoice_no,
       COALESCE(c.full_name, 'Walk-in') AS customer_name,
       b.title AS book_title,
       rli.quantity, rli.unit_price, rli.line_refund_amount,
       COALESCE(otli.unit_cost, lc.unit_cost, 0) AS resolved_unit_cost,
       r.refund_method, s.username AS staff_username
     FROM return_line_items rli
     JOIN returns r ON r.id = rli.return_id
     JOIN books b ON b.id = rli.book_id
     LEFT JOIN transactions t ON t.id = r.transaction_id
     LEFT JOIN customers c ON c.id = r.customer_id
     LEFT JOIN staff s ON s.id = r.processed_by
     LEFT JOIN transaction_line_items otli ON otli.id = rli.transaction_line_item_id
     ${costBasisLateralJoin('rli.book_id')}
     ${where}
     ORDER BY r.created_at DESC`,
    params,
  );

  return (res.rows as Record<string, unknown>[]).map(row => {
    const qty = row.quantity as number;
    const refundAmount = parseFloat(row.line_refund_amount as string);
    const unitCost = parseFloat((row.resolved_unit_cost as string | number | null) as string ?? '0');
    const originalCost = round2(unitCost * qty);
    return {
      returnNo:          row.return_number as string,
      originalInvoiceNo: (row.original_invoice_no as string | null) ?? '',
      customer:           row.customer_name as string,
      book:               row.book_title as string,
      qtyReturned:        qty,
      refundAmount,
      originalCost,
      profitReversed:     round2(refundAmount - originalCost),
      refundMethod:       row.refund_method as string,
      returnDate:         row.return_date as string,
      user:               (row.staff_username as string | null) ?? '',
    };
  });
}

// ── Exchange Report — per-exchange detail (Prompt 2) ────────────────────────
// Rebuilt from aggregate-only to one row per exchange (previous
// getExchangeReport() stays as the dashboard's aggregate/bySettlementType
// summary — this is the additional detail view/export). Multi-item
// exchanges list their books comma-joined, matching how the rest of this
// codebase already flattens multi-line entities for a single-row CSV
// export (e.g. Procurement's PROCUREMENT_COLUMNS is per-line instead, but
// an exchange's incoming/outgoing legs don't map onto Prompt 2's singular
// "Incoming Book"/"Outgoing Book" columns any other way without inventing
// a shape the ticket didn't ask for).

export interface ExchangeReportDetailRow {
  exchangeNo: string;
  customer: string;
  incomingBook: string;
  incomingValue: number;
  outgoingBook: string;
  outgoingValue: number;
  difference: number;
  differencePaymentStatus: string;
  cashCollected: number;
  receivableBalance: number;
  date: string;
  user: string;
}

export async function getExchangeReportRows(filters: ReportFilters): Promise<ExchangeReportDetailRow[]> {
  const { conditions, params } = buildDateConditions(filters, 'e');
  const where = 'WHERE ' + [...conditions, `e.status IN ('Completed','COMPLETED')`].join(' AND ');

  const res = await db.query(
    `SELECT
       e.exchange_reference, TO_CHAR(e.created_at, 'YYYY-MM-DD') AS date_str,
       COALESCE(c.full_name, 'Walk-in') AS customer_name,
       e.total_incoming_value, e.total_outgoing_value, e.net_balance,
       s.username AS staff_username,
       rec.status AS receivable_status,
       COALESCE(rec.outstanding_amount, 0) AS receivable_balance,
       COALESCE((
         SELECT SUM(CASE WHEN ese.entry_type = 'cash_payment' THEN ese.amount
                          WHEN ese.entry_type = 'cash_refund'  THEN -ese.amount
                          ELSE 0 END)
         FROM exchange_settlement_entries ese WHERE ese.exchange_id = e.id
       ), 0) AS cash_collected,
       COALESCE(
         (SELECT string_agg(DISTINCT b.title, ', ') FROM exchange_incoming_items ei JOIN books b ON b.id = ei.book_id WHERE ei.exchange_id = e.id),
         (SELECT string_agg(DISTINCT b.title, ', ') FROM exchange_items ei JOIN books b ON b.id = ei.book_id WHERE ei.exchange_id = e.id AND ei.type = 'returned'),
         ''
       ) AS incoming_book,
       COALESCE(
         (SELECT string_agg(DISTINCT b.title, ', ') FROM exchange_outgoing_items eo JOIN books b ON b.id = eo.book_id WHERE eo.exchange_id = e.id),
         (SELECT string_agg(DISTINCT b.title, ', ') FROM exchange_items ei JOIN books b ON b.id = ei.book_id WHERE ei.exchange_id = e.id AND ei.type = 'new'),
         ''
       ) AS outgoing_book
     FROM exchanges e
     LEFT JOIN customers c ON c.id = e.customer_id
     LEFT JOIN staff s ON s.id = e.created_by
     LEFT JOIN LATERAL (
       SELECT rec2.status, rec2.outstanding_amount FROM receivables rec2
       WHERE rec2.source_type = 'exchange_difference' AND rec2.source_entity_id = e.id
       LIMIT 1
     ) rec ON true
     ${where}
     ORDER BY e.created_at DESC`,
    params,
  );

  return (res.rows as Record<string, unknown>[]).map(row => ({
    exchangeNo:               row.exchange_reference as string,
    customer:                 row.customer_name as string,
    incomingBook:             (row.incoming_book as string | null) ?? '',
    incomingValue:            parseFloat(row.total_incoming_value as string),
    outgoingBook:             (row.outgoing_book as string | null) ?? '',
    outgoingValue:            parseFloat(row.total_outgoing_value as string),
    difference:               parseFloat(row.net_balance as string),
    differencePaymentStatus:  mapReceivableStatusLabel((row.receivable_status as string | null) ?? null),
    cashCollected:            parseFloat(row.cash_collected as string),
    receivableBalance:        parseFloat(row.receivable_balance as string),
    date:                     row.date_str as string,
    user:                     (row.staff_username as string | null) ?? '',
  }));
}

function mapReceivableStatusLabel(status: string | null): string {
  if (!status) return 'Settled'; // Even settlement, or Store_Refunds — nothing owed by the customer
  return status; // Pending | PartiallyPaid | Settled | Overdue
}

// ── Unified Payments Ledger (Prompt 2) ──────────────────────────────────────
// One true bidirectional ledger: customer receipts (IN) and supplier
// payments (OUT), replacing the customer-only getPaymentReport() for
// export/detail purposes (getPaymentReport() itself is unchanged and still
// backs the dashboard's Payment Methods chart). Six underlying sources,
// normalised to one row shape:
//   order_payments (IN), transaction_payments/POS (IN), refunds/POS returns
//   (OUT), order_refunds (OUT), exchange_settlement_entries cash entries
//   (IN or OUT), supplier_payments (OUT).

export interface PaymentsLedgerRow {
  receiptNo: string;
  party: string;
  referenceType: 'ORDER' | 'POS' | 'RETURN' | 'EXCHANGE' | 'PO';
  referenceNo: string;
  paymentMethod: string;
  amount: number;
  direction: 'IN' | 'OUT';
  date: string;
  user: string;
}

export async function getPaymentsLedgerRows(filters: ReportFilters): Promise<PaymentsLedgerRow[]> {
  const branchId = filters.branchId;
  const dateFrom = filters.dateFrom;
  const dateTo = filters.dateTo;

  // Each source builds its own params array (branch/date columns live on
  // different tables/aliases per source) then all six are UNIONed.
  function dateBranchClause(alias: string, branchExpr: string, dateCol = 'created_at'): { clause: string; params: unknown[] } {
    const params: unknown[] = [];
    const conds: string[] = [];
    if (branchId)  { params.push(branchId);  conds.push(`${branchExpr} = $${params.length}`); }
    if (dateFrom)  { params.push(dateFrom);  conds.push(`${alias}.${dateCol}::date >= $${params.length}::date`); }
    if (dateTo)    { params.push(dateTo);    conds.push(`${alias}.${dateCol}::date <= $${params.length}::date`); }
    return { clause: conds.length ? 'AND ' + conds.join(' AND ') : '', params };
  }

  const orderPay = dateBranchClause('op', 'o.branch_id', 'processed_at');
  const posPay = dateBranchClause('t', 't.branch_id');
  const posRefund = dateBranchClause('rf', 'r.branch_id');
  const orderRefund = dateBranchClause('ore', 'o2.branch_id');
  const exchSettle = dateBranchClause('ese', 'e.branch_id');
  const supPay = dateBranchClause('sp', 'sp.branch_id');

  const [orderRes, posRes, posRefundRes, orderRefundRes, exchRes, supRes] = await Promise.all([
    db.query(
      `SELECT op.payment_reference AS receipt_no, COALESCE(c.full_name, 'Walk-in') AS party,
              o.order_number AS reference_no, op.payment_method,
              op.amount, TO_CHAR(op.processed_at, 'YYYY-MM-DD') AS date_str,
              s.username AS staff_username
       FROM order_payments op
       JOIN orders o ON o.id = op.order_id
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN staff s ON s.id = op.processed_by
       WHERE op.status IN ('success', 'partially_refunded') ${orderPay.clause}`,
      orderPay.params,
    ),
    db.query(
      `SELECT ('TXN-PAY-' || tp.id) AS receipt_no, COALESCE(c.full_name, 'Walk-in') AS party,
              t.transaction_number AS reference_no, tp.method AS payment_method,
              tp.amount, TO_CHAR(tp.created_at, 'YYYY-MM-DD') AS date_str,
              s.username AS staff_username
       FROM transaction_payments tp
       JOIN transactions t ON t.id = tp.transaction_id
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN staff s ON s.id = t.staff_id
       WHERE t.status != 'voided' ${posPay.clause}`,
      posPay.params,
    ),
    db.query(
      `SELECT ('REF-' || rf.id) AS receipt_no, COALESCE(c.full_name, 'Walk-in') AS party,
              r.return_number AS reference_no, rf.method AS payment_method,
              rf.amount, TO_CHAR(rf.created_at, 'YYYY-MM-DD') AS date_str,
              s.username AS staff_username
       FROM refunds rf
       JOIN returns r ON r.id = rf.return_id
       LEFT JOIN customers c ON c.id = r.customer_id
       LEFT JOIN staff s ON s.id = r.processed_by
       WHERE r.status = 'completed' ${posRefund.clause}`,
      posRefund.params,
    ),
    db.query(
      `SELECT ('OREF-' || ore.id) AS receipt_no, COALESCE(c.full_name, 'Walk-in') AS party,
              o2.order_number AS reference_no, COALESCE(op2.payment_method, 'cash') AS payment_method,
              ore.refund_amount AS amount, TO_CHAR(ore.created_at, 'YYYY-MM-DD') AS date_str,
              s.username AS staff_username
       FROM order_refunds ore
       JOIN orders o2 ON o2.id = ore.order_id
       LEFT JOIN order_payments op2 ON op2.id = ore.payment_id
       LEFT JOIN customers c ON c.id = o2.customer_id
       LEFT JOIN staff s ON s.id = ore.processed_by
       WHERE 1=1 ${orderRefund.clause}`,
      orderRefund.params,
    ),
    db.query(
      `SELECT ('EXST-' || ese.id) AS receipt_no, COALESCE(c.full_name, 'Walk-in') AS party,
              e.exchange_reference AS reference_no, COALESCE(ese.method, 'cash') AS payment_method,
              ese.amount, ese.entry_type, TO_CHAR(ese.created_at, 'YYYY-MM-DD') AS date_str,
              s.username AS staff_username
       FROM exchange_settlement_entries ese
       JOIN exchanges e ON e.id = ese.exchange_id
       LEFT JOIN customers c ON c.id = e.customer_id
       LEFT JOIN staff s ON s.id = ese.authorised_by
       WHERE ese.entry_type IN ('cash_payment', 'cash_refund') ${exchSettle.clause}`,
      exchSettle.params,
    ),
    db.query(
      `SELECT COALESCE(sp.payment_number, 'SUP-' || sp.id) AS receipt_no, s2.name AS party,
              ('PO-' || LPAD(sp.po_id::text, 6, '0')) AS reference_no, sp.payment_method,
              sp.amount, TO_CHAR(sp.created_at, 'YYYY-MM-DD') AS date_str,
              s.username AS staff_username
       FROM supplier_payments sp
       JOIN suppliers s2 ON s2.id = sp.supplier_id
       LEFT JOIN staff s ON s.id = sp.created_by
       WHERE sp.reversed_at IS NULL ${supPay.clause}`,
      supPay.params,
    ),
  ]);

  const rows: PaymentsLedgerRow[] = [];
  const mapRow = (row: Record<string, unknown>, referenceType: PaymentsLedgerRow['referenceType'], direction: 'IN' | 'OUT'): PaymentsLedgerRow => ({
    receiptNo: row.receipt_no as string,
    party: row.party as string,
    referenceType,
    referenceNo: row.reference_no as string,
    paymentMethod: (row.payment_method as string | null) ?? '',
    amount: parseFloat(row.amount as string),
    direction,
    date: row.date_str as string,
    user: (row.staff_username as string | null) ?? '',
  });

  rows.push(...orderRes.rows.map(r => mapRow(r, 'ORDER', 'IN')));
  rows.push(...posRes.rows.map(r => mapRow(r, 'POS', 'IN')));
  rows.push(...posRefundRes.rows.map(r => mapRow(r, 'RETURN', 'OUT')));
  rows.push(...orderRefundRes.rows.map(r => mapRow(r, 'ORDER', 'OUT')));
  rows.push(...exchRes.rows.map(r => mapRow(r, 'EXCHANGE', (r.entry_type as string) === 'cash_payment' ? 'IN' : 'OUT')));
  rows.push(...supRes.rows.map(r => mapRow(r, 'PO', 'OUT')));

  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Top Returned Books (Prompt 2 — dashboard widget) ────────────────────────

export async function getTopReturnedBooks(filters: ReportFilters, limit = 10): Promise<Array<{
  bookId: number; title: string; unitsReturned: number; refundValue: number;
}>> {
  const { conditions, params } = buildDateConditions(filters, 'r');
  const where = 'WHERE ' + [...conditions, `r.status = 'completed'`].join(' AND ');
  const res = await db.query(
    `SELECT rli.book_id, b.title,
            SUM(rli.quantity)::INTEGER AS units_returned,
            COALESCE(SUM(rli.line_refund_amount), 0)::NUMERIC AS refund_value
     FROM return_line_items rli
     JOIN returns r ON r.id = rli.return_id
     JOIN books b ON b.id = rli.book_id
     ${where}
     GROUP BY rli.book_id, b.title
     ORDER BY units_returned DESC
     LIMIT ${Math.max(1, Math.min(50, limit))}`,
    params,
  );
  return res.rows.map((row: Record<string, unknown>) => ({
    bookId: row.book_id as number,
    title: row.title as string,
    unitsReturned: row.units_returned as number,
    refundValue: parseFloat(row.refund_value as string),
  }));
}

// ── Gross Profit Trend (Prompt 2 — dashboard chart) ─────────────────────────
// ── Procurement reports (Prompt 2) ──────────────────────────────────────────
// All six share the same received-value payable basis as
// procurement.service.ts's recomputeFinancialStatus() (Prompt 2 decision
// #5) — SUM(received_quantity × unit_cost) per line, not the PO's full
// total_amount — so these reports reconcile with the supplier ledger and
// the PO detail view's own outstanding-balance figure.

const PO_BALANCE_SUBQUERY = `
  COALESCE((SELECT SUM(pli.received_quantity * pli.unit_cost) FROM po_line_items pli WHERE pli.po_id = po.id), 0)
  - COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.po_id = po.id AND sp.reversed_at IS NULL), 0)
  - COALESCE((SELECT SUM(cn.amount) FROM supplier_credit_notes cn WHERE cn.po_id = po.id), 0)`;

// ── Open POs ─────────────────────────────────────────────────────────────────

export interface OpenPoRow {
  poReference: string; supplier: string; orderDate: string; expectedDate: string;
  orderedQty: number; receivedQty: number; totalAmount: number; outstandingAmount: number;
  receiptStatus: string; paymentStatus: string;
}

export async function getOpenPOs(filters: ReportFilters): Promise<OpenPoRow[]> {
  const params: unknown[] = [];
  const conditions: string[] = [`po.status NOT IN ('closed','cancelled')`];
  if (filters.branchId) { params.push(filters.branchId); conditions.push(`po.branch_id = $${params.length}`); }
  const where = 'WHERE ' + conditions.join(' AND ');
  const res = await db.query(
    `SELECT po.id, s.name AS supplier_name, TO_CHAR(po.created_at,'YYYY-MM-DD') AS order_date,
            TO_CHAR(po.expected_delivery_date,'YYYY-MM-DD') AS expected_date, po.status, po.total_amount,
            COALESCE((SELECT SUM(quantity) FROM po_line_items WHERE po_id = po.id), 0) AS ordered_qty,
            COALESCE((SELECT SUM(received_quantity) FROM po_line_items WHERE po_id = po.id), 0) AS received_qty,
            (${PO_BALANCE_SUBQUERY}) AS outstanding_amount,
            po.financial_status
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     ${where}
     ORDER BY po.created_at DESC`,
    params,
  );
  return (res.rows as Record<string, unknown>[]).map(row => ({
    poReference: `PO-${String(row.id).padStart(6, '0')}`,
    supplier: row.supplier_name as string,
    orderDate: row.order_date as string,
    expectedDate: (row.expected_date as string | null) ?? '',
    orderedQty: Number(row.ordered_qty), receivedQty: Number(row.received_qty),
    totalAmount: parseFloat(row.total_amount as string),
    outstandingAmount: parseFloat(row.outstanding_amount as string),
    receiptStatus: row.status as string,
    paymentStatus: row.financial_status as string,
  }));
}

// ── Supplier Balances ────────────────────────────────────────────────────────

export interface SupplierBalanceRow {
  supplierId: number; supplier: string; openPoCount: number;
  receivedValue: number; paid: number; credited: number; outstandingBalance: number;
}

export async function getSupplierBalances(filters: ReportFilters): Promise<SupplierBalanceRow[]> {
  const params: unknown[] = [];
  const conditions: string[] = [`po.status NOT IN ('draft','cancelled')`];
  if (filters.branchId) { params.push(filters.branchId); conditions.push(`po.branch_id = $${params.length}`); }
  const where = 'WHERE ' + conditions.join(' AND ');
  const res = await db.query(
    `SELECT s.id AS supplier_id, s.name AS supplier_name,
            COUNT(DISTINCT po.id) FILTER (WHERE po.status NOT IN ('closed','cancelled')) AS open_po_count,
            COALESCE(SUM((SELECT SUM(pli.received_quantity * pli.unit_cost) FROM po_line_items pli WHERE pli.po_id = po.id)), 0) AS received_value,
            COALESCE(SUM((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.po_id = po.id AND sp.reversed_at IS NULL)), 0) AS paid,
            COALESCE(SUM((SELECT SUM(cn.amount) FROM supplier_credit_notes cn WHERE cn.po_id = po.id)), 0) AS credited
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     ${where}
     GROUP BY s.id, s.name
     ORDER BY s.name ASC`,
    params,
  );
  return (res.rows as Record<string, unknown>[]).map(row => {
    const receivedValue = parseFloat(row.received_value as string);
    const paid = parseFloat(row.paid as string);
    const credited = parseFloat(row.credited as string);
    return {
      supplierId: row.supplier_id as number,
      supplier: row.supplier_name as string,
      openPoCount: parseInt(row.open_po_count as string, 10),
      receivedValue, paid, credited,
      outstandingBalance: round2(receivedValue - paid - credited),
    };
  });
}

// ── AP Aging ─────────────────────────────────────────────────────────────────
// No formal PO due-date column exists — buckets by days since the PO's most
// recent goods receipt (the event that created the payable), mirroring how
// the Receivables Aging Report buckets by days past due.

export async function getApAgingReport(filters: ReportFilters): Promise<{
  rows: Array<{ supplier: string; poReference: string; outstandingAmount: number; agingBucket: AgingBucket; lastReceiptDate: string }>;
  byBucket: Array<{ bucket: AgingBucket; count: number; totalOutstanding: number }>;
}> {
  const params: unknown[] = [];
  const conditions: string[] = [`po.status NOT IN ('draft','cancelled')`];
  if (filters.branchId) { params.push(filters.branchId); conditions.push(`po.branch_id = $${params.length}`); }
  const where = 'WHERE ' + conditions.join(' AND ');
  const res = await db.query(
    `SELECT po.id, s.name AS supplier_name,
            (${PO_BALANCE_SUBQUERY}) AS outstanding_amount,
            (SELECT MAX(r.received_at) FROM po_receipts r WHERE r.po_id = po.id) AS last_receipt_at
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     ${where}`,
    params,
  );
  const rows: Array<{ supplier: string; poReference: string; outstandingAmount: number; agingBucket: AgingBucket; lastReceiptDate: string }> = [];
  for (const row of res.rows as Record<string, unknown>[]) {
    const outstanding = parseFloat(row.outstanding_amount as string);
    if (outstanding <= 0.01) continue; // fully settled or nothing received yet
    const lastReceiptAt = row.last_receipt_at as Date | null;
    const daysSince = lastReceiptAt ? Math.floor((Date.now() - lastReceiptAt.getTime()) / 86_400_000) : 0;
    rows.push({
      supplier: row.supplier_name as string,
      poReference: `PO-${String(row.id).padStart(6, '0')}`,
      outstandingAmount: outstanding,
      agingBucket: bucketForDaysOverdue(daysSince),
      lastReceiptDate: lastReceiptAt ? lastReceiptAt.toISOString().slice(0, 10) : '',
    });
  }
  const bucketOrder: AgingBucket[] = ['Current', '1-30', '31-60', '61-90', '90+'];
  const byBucket = bucketOrder.map(bucket => {
    const inBucket = rows.filter(r => r.agingBucket === bucket);
    return { bucket, count: inBucket.length, totalOutstanding: round2(inBucket.reduce((s, r) => s + r.outstandingAmount, 0)) };
  });
  return { rows, byBucket };
}

// ── Purchases by Supplier ─────────────────────────────────────────────────────

export async function getPurchasesBySupplier(filters: ReportFilters): Promise<Array<{
  supplierId: number; supplier: string; poCount: number; orderedValue: number; receivedValue: number;
}>> {
  const { conditions, params } = buildDateConditions(filters, 'po');
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const res = await db.query(
    `SELECT s.id AS supplier_id, s.name AS supplier_name,
            COUNT(DISTINCT po.id) AS po_count,
            COALESCE(SUM(po.total_amount), 0) AS ordered_value,
            COALESCE(SUM((SELECT SUM(pli.received_quantity * pli.unit_cost) FROM po_line_items pli WHERE pli.po_id = po.id)), 0) AS received_value
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     ${where}${where ? ' AND' : 'WHERE'} po.status != 'cancelled'
     GROUP BY s.id, s.name
     ORDER BY ordered_value DESC`,
    params,
  );
  return (res.rows as Record<string, unknown>[]).map(row => ({
    supplierId: row.supplier_id as number,
    supplier: row.supplier_name as string,
    poCount: parseInt(row.po_count as string, 10),
    orderedValue: parseFloat(row.ordered_value as string),
    receivedValue: parseFloat(row.received_value as string),
  }));
}

// ── Purchases by Book ─────────────────────────────────────────────────────────

export async function getPurchasesByBook(filters: ReportFilters): Promise<Array<{
  bookId: number; title: string; isbn: string; orderedQty: number; receivedQty: number; totalValue: number;
}>> {
  const { conditions, params } = buildDateConditions(filters, 'po');
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const res = await db.query(
    `SELECT pli.book_id, b.title, b.isbn,
            SUM(pli.quantity) AS ordered_qty,
            SUM(pli.received_quantity) AS received_qty,
            SUM(pli.quantity * pli.unit_cost) AS total_value
     FROM po_line_items pli
     JOIN purchase_orders po ON po.id = pli.po_id
     JOIN books b ON b.id = pli.book_id
     ${where}${where ? ' AND' : 'WHERE'} po.status != 'cancelled'
     GROUP BY pli.book_id, b.title, b.isbn
     ORDER BY total_value DESC`,
    params,
  );
  return (res.rows as Record<string, unknown>[]).map(row => ({
    bookId: row.book_id as number,
    title: row.title as string,
    isbn: (row.isbn as string | null) ?? '',
    orderedQty: parseInt(row.ordered_qty as string, 10),
    receivedQty: parseInt(row.received_qty as string, 10),
    totalValue: parseFloat(row.total_value as string),
  }));
}

// ── Supplier Payment History ──────────────────────────────────────────────────

export async function getSupplierPaymentHistory(filters: ReportFilters): Promise<Array<{
  date: string; supplier: string; poReference: string; amount: number;
  paymentMethod: string; source: string; user: string;
}>> {
  const { conditions, params } = buildDateConditions(filters, 'sp');
  // A reversed payment was a mistake: it was never paid.
  const where = 'WHERE ' + ['sp.reversed_at IS NULL', ...conditions].join(' AND ');
  const res = await db.query(
    `SELECT TO_CHAR(sp.created_at,'YYYY-MM-DD') AS date_str, s.name AS supplier_name, sp.po_id,
            sp.amount, sp.payment_method, sp.source, st.username AS staff_username
     FROM supplier_payments sp
     JOIN suppliers s ON s.id = sp.supplier_id
     LEFT JOIN staff st ON st.id = sp.created_by
     ${where}
     ORDER BY sp.created_at DESC`,
    params,
  );
  return (res.rows as Record<string, unknown>[]).map(row => ({
    date: row.date_str as string,
    supplier: row.supplier_name as string,
    poReference: `PO-${String(row.po_id).padStart(6, '0')}`,
    amount: parseFloat(row.amount as string),
    paymentMethod: row.payment_method as string,
    source: row.source as string,
    user: (row.staff_username as string | null) ?? '',
  }));
}
