// ── FinancialReportService ──────────────────────────────────────────────────
//
// Dashboard Standardization & Unified Reports Engine (extended by "Prompt 2"
// — Modern KPI Dashboard, Synchronized Reports & Production-Grade Procurement
// Lifecycle — to add per-line cost/profit and invoice-level cash/receivable
// figures).
//
// Single calculation engine shared by the Sales CSV export and the
// Dashboard's Sales Performance cards (Net Sales, Gross Profit, Gross
// Margin %) — both read from getUnifiedTransactionRows() (or its in-process
// summary, which is literally SUM() over the same rows), so a dashboard
// total for a given date range can never mathematically diverge from the
// CSV export for that same range: they're the same rows.
//
// Covers all four revenue-moving channels, one row per line item:
//   ORDER    — order_line_items (excludes Cancelled/CANCELLED orders)
//   POS      — transaction_line_items (excludes voided transactions)
//   RETURN   — return_line_items (excludes rejected returns); quantity and
//              netAmount are negative — a return reduces net sales.
//   EXCHANGE — exchange_incoming_items/exchange_outgoing_items (Quick
//              Exchange, the reachable creation path) and, for completeness,
//              exchange_items (the initiate/review/approve/settle lifecycle,
//              currently UI-unreachable but reachable via the API) —
//              excludes Cancelled exchanges. An exchange contributes one row
//              per item: incoming (trade-in) rows carry a NEGATIVE netAmount
//              (the allowance credited to the customer reduces net revenue),
//              outgoing rows carry a POSITIVE netAmount — summed together
//              for one exchange this nets to exactly its cash difference
//              (Customer_Pays/Store_Refunds), matching the "± Exchange
//              Difference" term in the Net Sales Revenue formula. Quantity
//              is positive for both (only RETURN rows get a negative
//              quantity, per the ticket's column spec).
//
// ── Cost / Gross Profit (Prompt 2 addition) ─────────────────────────────────
// costAmount is signed to match netAmount's sign convention, so
// `grossProfit = netAmount - costAmount` works uniformly across every row
// type without a branch per type:
//   ORDER / POS            — costAmount = +(persisted unit_cost × qty).
//                             Sourced from order_line_items.unit_cost /
//                             transaction_line_items.unit_cost (Prompt 1's
//                             Sales Posting Rule persistence), falling back
//                             to costBasis.ts's most-recent-cost lookup only
//                             for rows that predate that migration.
//   RETURN                 — costAmount = -(original sale's persisted
//                             unit_cost × qty), i.e. the same cost credited
//                             back that returns.service.ts restored
//                             inventory at (Return Posting Rule). This makes
//                             a return's grossProfit contribution exactly
//                             -(original margin on the returned units), never
//                             the full refund amount.
//   EXCHANGE incoming       — costAmount = 0. A trade-in receipt isn't a
//   (trade-in)                sale — there's no COGS to net against the
//                             allowance paid out; the allowance's full cash
//                             impact already flows through as netAmount, and
//                             it simply reduces gross profit by that same
//                             amount (consistent with how it already reduces
//                             net sales revenue). The item's evaluated price
//                             becomes its cost basis in inventory instead
//                             (see exchanges.service.ts / Prompt 1).
//   EXCHANGE outgoing        — costAmount = +(persisted unit_cost × qty),
//   (resale)                  same treatment as ORDER/POS — this leg IS a
//                             sale.
//
// ── Cash Collected / Receivable Balance (Prompt 2 addition) ────────────────
// These are invoice-level facts (how much of the whole order/transaction/
// exchange has been paid vs. is still outstanding), not line-item facts —
// the same value is repeated on every line belonging to that invoice,
// matching how a real flat sales-report export normally surfaces them.
// RETURN rows: a refund is a completed cash event at creation time (no
// receivable is ever opened for a return), so both are always 0.
//
// This is deliberately additive on top of the pre-existing engine: it does
// NOT change lib/profit.service.ts's computeNetProfit() (collected-cash
// revenue recognition for credit sales — an existing, separately-tested
// accounting policy, still used for Cash & Receivables dashboard metrics
// and financial-integrity tests). "Net Sales"/"Gross Profit" here are a
// distinct, invoiced/gross-accrual figure — every qualifying order/POS/
// return/exchange line for the period, regardless of whether a credit sale
// has been collected yet. Both are legitimate, commonly-used financial
// lenses (cash vs accrual); this module's numbers are the ones the Sales
// Report/CSV export and the dashboard's Sales Performance cards reconcile
// with, by construction, since Prompt 2 designates accrual as canonical for
// those specific cards/columns.

import { db } from '../../db/index.js';
import { costBasisLateralJoin } from '../../lib/costBasis.js';

export interface ReportFilters {
  branchId?: number;
  dateFrom?: string;
  dateTo?: string;
}

export type TransactionType = 'ORDER' | 'POS' | 'RETURN' | 'EXCHANGE';

export interface UnifiedTransactionRow {
  transactionDate: string;      // YYYY-MM-DD, local (DB session) date — never a JS Date/toISOString() round-trip
  transactionType: TransactionType;
  referenceNumber: string;
  branch: string;
  locationName: string;
  customerName: string;
  bookTitle: string;
  bookIsbn: string;
  quantity: number;             // positive for ORDER/POS/EXCHANGE; negative for RETURN
  unitPrice: number;
  discountAmount: number;
  grossAmount: number;
  netAmount: number;            // gross − discount for ORDER/POS; −refund for RETURN; ±allowance/sale for EXCHANGE
  costAmount: number;           // signed to match netAmount — see header comment
  grossProfit: number;          // netAmount − costAmount
  paymentStatus: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID';
  paymentMethod: string;
  cashCollected: number;        // invoice-level, repeated per line of that invoice
  receivableBalance: number;    // invoice-level, repeated per line of that invoice
  staffUsername: string;
}

export interface UnifiedFinancialSummary {
  grossSales: number;
  discounts: number;
  returnsValue: number;         // positive magnitude
  exchangeDifference: number;   // signed: outgoing − incoming across all exchange line items
  netSalesRevenue: number;      // grossSales − discounts − returnsValue + exchangeDifference
  costAmount: number;           // SUM of every row's signed costAmount
  grossProfit: number;          // netSalesRevenue − costAmount (== SUM of every row's grossProfit)
  grossMarginPct: number;       // grossProfit / netSalesRevenue × 100 (0 when netSalesRevenue is 0)
  rowCount: number;
}

// ── Payment method vocabulary mapping ───────────────────────────────────────
// order_payments/transaction_payments/refunds/exchange settlement entries
// all use lowercase snake_case method values from their own (slightly
// different) CHECK constraints — normalise to the ticket's UPPER_SNAKE
// vocabulary. Unrecognised values pass through uppercased rather than being
// dropped, so a legitimate method never silently disappears from the export.
const PAYMENT_METHOD_MAP: Record<string, string> = {
  cash: 'CASH',
  bank: 'BANK_TRANSFER',
  mobile: 'MOBILE_MONEY',
  store_credit: 'STORE_CREDIT',
  card: 'CARD',
  loyalty_points: 'LOYALTY_POINTS',
  other: 'OTHER',
};
function mapPaymentMethod(raw: string | null | undefined): string {
  if (!raw) return '';
  return PAYMENT_METHOD_MAP[raw] ?? raw.toUpperCase();
}

function mapOrderPaymentStatus(raw: string): 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' {
  if (raw === 'paid') return 'PAID';
  if (raw === 'partial') return 'PARTIALLY_PAID';
  return 'UNPAID'; // unpaid, refunded
}
function mapPosPaymentStatus(raw: string): 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' {
  if (raw === 'paid') return 'PAID';
  if (raw === 'partial') return 'PARTIALLY_PAID';
  return 'UNPAID'; // credit
}
function mapReceivableStatusToPaymentStatus(status: string | null): 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' {
  if (!status) return 'PAID'; // no receivable at all (Even, or Store_Refunds) — nothing outstanding on the sale side
  if (status === 'Settled') return 'PAID';
  if (status === 'PartiallyPaid') return 'PARTIALLY_PAID';
  return 'UNPAID'; // Pending, Overdue
}

function buildDateBranchConditions(filters: ReportFilters, alias: string, dateCol = 'created_at'): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.branchId) { params.push(filters.branchId); conditions.push(`${alias}.branch_id = $${params.length}`); }
  if (filters.dateFrom) { params.push(filters.dateFrom); conditions.push(`${alias}.${dateCol}::date >= $${params.length}::date`); }
  if (filters.dateTo)   { params.push(filters.dateTo);   conditions.push(`${alias}.${dateCol}::date <= $${params.length}::date`); }
  return { conditions, params };
}

// LATERAL fragment resolving how much of an order has been paid to date —
// mirrors orders.service.ts's own "total paid" query (success/partially_refunded).
const ORDER_CASH_LATERAL = `
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(op.amount), 0) AS paid
       FROM order_payments op
       WHERE op.order_id = o.id AND op.status IN ('success', 'partially_refunded')
     ) ocash ON true
     LEFT JOIN LATERAL (
       SELECT rec.outstanding_amount FROM receivables rec
       WHERE rec.source_type = 'order_credit_sale' AND rec.source_entity_id = o.id
       LIMIT 1
     ) orec ON true`;

const POS_CASH_LATERAL = `
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(tp.amount), 0) AS paid
       FROM transaction_payments tp
       WHERE tp.transaction_id = t.id
     ) tcash ON true
     LEFT JOIN LATERAL (
       SELECT rec.outstanding_amount FROM receivables rec
       WHERE rec.source_type = 'pos_credit_sale' AND rec.source_entity_id = t.id
       LIMIT 1
     ) trec ON true`;

const EXCHANGE_CASH_LATERAL = `
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(CASE WHEN ese.entry_type = 'cash_payment' THEN ese.amount
                                 WHEN ese.entry_type = 'cash_refund'  THEN -ese.amount
                                 ELSE 0 END), 0) AS net_cash
       FROM exchange_settlement_entries ese WHERE ese.exchange_id = e.id
     ) ecash ON true
     LEFT JOIN LATERAL (
       SELECT rec.outstanding_amount FROM receivables rec
       WHERE rec.source_type = 'exchange_difference' AND rec.source_entity_id = e.id
       LIMIT 1
     ) erec ON true`;

// ── ORDER rows ───────────────────────────────────────────────────────────────

async function getOrderRows(filters: ReportFilters): Promise<UnifiedTransactionRow[]> {
  const { conditions, params } = buildDateBranchConditions(filters, 'o');
  conditions.unshift(`o.status NOT IN ('Cancelled','CANCELLED')`);
  const where = 'WHERE ' + conditions.join(' AND ');

  const res = await db.query(
    `SELECT
       TO_CHAR(o.created_at, 'YYYY-MM-DD') AS transaction_date,
       o.order_number AS reference_number,
       br.name AS branch, loc.name AS location_name,
       COALESCE(c.full_name, 'Walk-in') AS customer_name,
       b.title AS book_title, b.isbn AS book_isbn,
       oli.quantity, oli.unit_price, oli.discount_amount, oli.total_price,
       COALESCE(oli.unit_cost, lc.unit_cost, 0) AS resolved_unit_cost,
       o.payment_status,
       opay.payment_method,
       ocash.paid AS cash_collected, orec.outstanding_amount AS receivable_balance,
       s.username AS staff_username
     FROM order_line_items oli
     JOIN orders o ON o.id = oli.order_id
     JOIN books b ON b.id = oli.book_id
     JOIN branches br ON br.id = o.branch_id
     LEFT JOIN locations loc ON loc.id = o.location_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN staff s ON s.id = o.created_by
     ${costBasisLateralJoin('oli.book_id')}
     ${ORDER_CASH_LATERAL}
     LEFT JOIN LATERAL (
       SELECT op.payment_method FROM order_payments op
       WHERE op.order_id = o.id AND op.status IN ('success', 'partially_refunded')
       ORDER BY op.created_at DESC LIMIT 1
     ) opay ON true
     ${where}
     ORDER BY o.created_at`,
    params,
  );

  return res.rows.map((row): UnifiedTransactionRow => {
    const quantity = row.quantity as number;
    const unitPrice = parseFloat(row.unit_price as string);
    const discountAmount = parseFloat(row.discount_amount as string);
    const grossAmount = parseFloat((unitPrice * quantity).toFixed(2));
    const netAmount = parseFloat(row.total_price as string);
    const unitCost = parseFloat((row.resolved_unit_cost as string | number | null) as string ?? '0');
    const costAmount = parseFloat((unitCost * quantity).toFixed(2));
    return {
      transactionDate: row.transaction_date as string,
      transactionType: 'ORDER',
      referenceNumber: row.reference_number as string,
      branch: row.branch as string,
      locationName: (row.location_name as string | null) ?? '',
      customerName: row.customer_name as string,
      bookTitle: row.book_title as string,
      bookIsbn: (row.book_isbn as string | null) ?? '',
      quantity, unitPrice, discountAmount, grossAmount, netAmount,
      costAmount,
      grossProfit: parseFloat((netAmount - costAmount).toFixed(2)),
      paymentStatus: mapOrderPaymentStatus(row.payment_status as string),
      paymentMethod: mapPaymentMethod(row.payment_method as string | null),
      cashCollected: parseFloat((row.cash_collected as string | number | null) as string ?? '0'),
      receivableBalance: parseFloat((row.receivable_balance as string | number | null) as string ?? '0'),
      staffUsername: (row.staff_username as string | null) ?? '',
    };
  });
}

// ── POS rows ─────────────────────────────────────────────────────────────────

async function getPosRows(filters: ReportFilters): Promise<UnifiedTransactionRow[]> {
  const { conditions, params } = buildDateBranchConditions(filters, 't');
  conditions.unshift(`t.status != 'voided'`);
  const where = 'WHERE ' + conditions.join(' AND ');

  const res = await db.query(
    `SELECT
       TO_CHAR(t.created_at, 'YYYY-MM-DD') AS transaction_date,
       t.transaction_number AS reference_number,
       br.name AS branch, loc.name AS location_name,
       COALESCE(c.full_name, 'Walk-in') AS customer_name,
       b.title AS book_title, b.isbn AS book_isbn,
       tli.quantity, tli.unit_price, tli.discount_amount, tli.line_total,
       COALESCE(tli.unit_cost, lc.unit_cost, 0) AS resolved_unit_cost,
       t.payment_status,
       tpay.method AS payment_method,
       tcash.paid AS cash_collected, trec.outstanding_amount AS receivable_balance,
       s.username AS staff_username
     FROM transaction_line_items tli
     JOIN transactions t ON t.id = tli.transaction_id
     JOIN books b ON b.id = tli.book_id
     JOIN branches br ON br.id = t.branch_id
     LEFT JOIN locations loc ON loc.id = t.location_id
     LEFT JOIN customers c ON c.id = t.customer_id
     LEFT JOIN staff s ON s.id = t.staff_id
     ${costBasisLateralJoin('tli.book_id')}
     ${POS_CASH_LATERAL}
     LEFT JOIN LATERAL (
       SELECT tp.method FROM transaction_payments tp
       WHERE tp.transaction_id = t.id
       ORDER BY tp.created_at DESC LIMIT 1
     ) tpay ON true
     ${where}
     ORDER BY t.created_at`,
    params,
  );

  return res.rows.map((row): UnifiedTransactionRow => {
    const quantity = row.quantity as number;
    const unitPrice = parseFloat(row.unit_price as string);
    const discountAmount = parseFloat(row.discount_amount as string);
    const grossAmount = parseFloat((unitPrice * quantity).toFixed(2));
    const netAmount = parseFloat(row.line_total as string);
    const unitCost = parseFloat((row.resolved_unit_cost as string | number | null) as string ?? '0');
    const costAmount = parseFloat((unitCost * quantity).toFixed(2));
    return {
      transactionDate: row.transaction_date as string,
      transactionType: 'POS',
      referenceNumber: row.reference_number as string,
      branch: row.branch as string,
      locationName: (row.location_name as string | null) ?? '',
      customerName: row.customer_name as string,
      bookTitle: row.book_title as string,
      bookIsbn: (row.book_isbn as string | null) ?? '',
      quantity, unitPrice, discountAmount, grossAmount, netAmount,
      costAmount,
      grossProfit: parseFloat((netAmount - costAmount).toFixed(2)),
      paymentStatus: mapPosPaymentStatus(row.payment_status as string),
      paymentMethod: mapPaymentMethod(row.payment_method as string | null),
      cashCollected: parseFloat((row.cash_collected as string | number | null) as string ?? '0'),
      receivableBalance: parseFloat((row.receivable_balance as string | number | null) as string ?? '0'),
      staffUsername: (row.staff_username as string | null) ?? '',
    };
  });
}

// ── RETURN rows ──────────────────────────────────────────────────────────────

async function getReturnRows(filters: ReportFilters): Promise<UnifiedTransactionRow[]> {
  const { conditions, params } = buildDateBranchConditions(filters, 'r');
  conditions.unshift(`r.status = 'completed'`); // excludes 'rejected'
  const where = 'WHERE ' + conditions.join(' AND ');

  const res = await db.query(
    `SELECT
       TO_CHAR(r.created_at, 'YYYY-MM-DD') AS transaction_date,
       r.return_number AS reference_number,
       br.name AS branch, loc.name AS location_name,
       COALESCE(c.full_name, 'Walk-in') AS customer_name,
       b.title AS book_title, b.isbn AS book_isbn,
       rli.quantity, rli.unit_price, rli.line_refund_amount,
       COALESCE(otli.unit_cost, lc.unit_cost, 0) AS resolved_unit_cost,
       r.refund_method,
       s.username AS staff_username
     FROM return_line_items rli
     JOIN returns r ON r.id = rli.return_id
     JOIN books b ON b.id = rli.book_id
     JOIN branches br ON br.id = r.branch_id
     LEFT JOIN transactions t ON t.id = r.transaction_id
     LEFT JOIN locations loc ON loc.id = t.location_id
     LEFT JOIN customers c ON c.id = r.customer_id
     LEFT JOIN staff s ON s.id = r.processed_by
     LEFT JOIN transaction_line_items otli ON otli.id = rli.transaction_line_item_id
     ${costBasisLateralJoin('rli.book_id')}
     ${where}
     ORDER BY r.created_at`,
    params,
  );

  return res.rows.map((row): UnifiedTransactionRow => {
    const quantity = row.quantity as number;
    const unitPrice = parseFloat(row.unit_price as string);
    const grossAmount = parseFloat((unitPrice * quantity).toFixed(2));
    const refundAmount = parseFloat(row.line_refund_amount as string);
    const unitCost = parseFloat((row.resolved_unit_cost as string | number | null) as string ?? '0');
    // Negative — this row credits COGS back (Return Posting Rule), symmetric
    // with netAmount's own negative sign for a return.
    const costAmount = parseFloat((-(unitCost * quantity)).toFixed(2));
    const netAmount = -refundAmount;
    return {
      transactionDate: row.transaction_date as string,
      transactionType: 'RETURN',
      referenceNumber: row.reference_number as string,
      branch: row.branch as string,
      locationName: (row.location_name as string | null) ?? '',
      customerName: row.customer_name as string,
      bookTitle: row.book_title as string,
      bookIsbn: (row.book_isbn as string | null) ?? '',
      quantity: -quantity,            // negative — a return reduces stock/sales
      unitPrice,
      discountAmount: 0,              // returns don't carry a discount concept
      grossAmount,
      netAmount,                      // reduces net sales revenue
      costAmount,
      grossProfit: parseFloat((netAmount - costAmount).toFixed(2)),
      paymentStatus: 'PAID',          // the refund is processed at creation — nothing left outstanding
      paymentMethod: mapPaymentMethod(row.refund_method as string | null),
      cashCollected: 0,                // a refund is a completed cash outflow, not a collection
      receivableBalance: 0,            // no receivable is ever opened for a return
      staffUsername: (row.staff_username as string | null) ?? '',
    };
  });
}

// ── EXCHANGE rows ────────────────────────────────────────────────────────────
// Covers both storage shapes exactly like exchanges.service.ts's fetchItems()
// does — an exchange only ever has rows in ONE of the two, so the legacy
// query explicitly skips any exchange that has unified exchange_items rows,
// to avoid double-counting.

async function getExchangeRows(filters: ReportFilters): Promise<UnifiedTransactionRow[]> {
  const legacyIncoming = buildDateBranchConditions(filters, 'e');
  legacyIncoming.conditions.unshift(`e.status IN ('Completed','COMPLETED')`);
  legacyIncoming.conditions.push(`NOT EXISTS (SELECT 1 FROM exchange_items ei2 WHERE ei2.exchange_id = e.id)`);

  const legacyOutgoing = buildDateBranchConditions(filters, 'e');
  legacyOutgoing.conditions.unshift(`e.status IN ('Completed','COMPLETED')`);
  legacyOutgoing.conditions.push(`NOT EXISTS (SELECT 1 FROM exchange_items ei2 WHERE ei2.exchange_id = e.id)`);

  const unified = buildDateBranchConditions(filters, 'e');
  unified.conditions.unshift(`(e.lifecycle_status = 'COMPLETED' OR (e.lifecycle_status IS NULL AND e.status IN ('Completed','COMPLETED')))`);

  const paymentMethodLateral = `
     LEFT JOIN LATERAL (
       SELECT ese.method FROM exchange_settlement_entries ese
       WHERE ese.exchange_id = e.id AND ese.entry_type IN ('cash_payment', 'cash_refund') AND ese.method IS NOT NULL
       ORDER BY ese.id DESC LIMIT 1
     ) pay ON true`;
  const receivableLateral = `
     LEFT JOIN LATERAL (
       SELECT rec.status FROM receivables rec
       WHERE rec.source_type = 'exchange_difference' AND rec.source_entity_id = e.id
       LIMIT 1
     ) rec ON true`;
  const commonJoins = `
     JOIN branches br ON br.id = e.branch_id
     LEFT JOIN locations loc ON loc.id = e.location_id
     LEFT JOIN customers c ON c.id = e.customer_id
     LEFT JOIN staff s ON s.id = e.created_by
     ${paymentMethodLateral}
     ${receivableLateral}
     ${EXCHANGE_CASH_LATERAL}`;

  const [incomingRes, outgoingRes, unifiedRes] = await Promise.all([
    db.query(
      `SELECT
         TO_CHAR(e.created_at, 'YYYY-MM-DD') AS transaction_date,
         e.exchange_reference AS reference_number, br.name AS branch, loc.name AS location_name,
         COALESCE(c.full_name, 'Walk-in') AS customer_name,
         b.title AS book_title, b.isbn AS book_isbn,
         ei.quantity, ei.evaluated_unit_price AS unit_price, ei.total_price,
         pay.method AS payment_method, rec.status AS receivable_status,
         ecash.net_cash AS cash_collected, erec.outstanding_amount AS receivable_balance,
         s.username AS staff_username
       FROM exchange_incoming_items ei
       JOIN exchanges e ON e.id = ei.exchange_id
       JOIN books b ON b.id = ei.book_id
       ${commonJoins}
       WHERE ${legacyIncoming.conditions.join(' AND ')}
       ORDER BY e.created_at`,
      legacyIncoming.params,
    ),
    db.query(
      `SELECT
         TO_CHAR(e.created_at, 'YYYY-MM-DD') AS transaction_date,
         e.exchange_reference AS reference_number, br.name AS branch, loc.name AS location_name,
         COALESCE(c.full_name, 'Walk-in') AS customer_name,
         b.title AS book_title, b.isbn AS book_isbn,
         eo.quantity, eo.selling_unit_price AS unit_price, eo.total_price,
         COALESCE(eo.unit_cost, lc.unit_cost, 0) AS resolved_unit_cost,
         pay.method AS payment_method, rec.status AS receivable_status,
         ecash.net_cash AS cash_collected, erec.outstanding_amount AS receivable_balance,
         s.username AS staff_username
       FROM exchange_outgoing_items eo
       JOIN exchanges e ON e.id = eo.exchange_id
       JOIN books b ON b.id = eo.book_id
       ${commonJoins}
       ${costBasisLateralJoin('eo.book_id')}
       WHERE ${legacyOutgoing.conditions.join(' AND ')}
       ORDER BY e.created_at`,
      legacyOutgoing.params,
    ),
    db.query(
      `SELECT
         TO_CHAR(e.created_at, 'YYYY-MM-DD') AS transaction_date,
         e.exchange_reference AS reference_number, br.name AS branch, loc.name AS location_name,
         COALESCE(c.full_name, 'Walk-in') AS customer_name,
         b.title AS book_title, b.isbn AS book_isbn,
         ei.quantity, ei.unit_price, ei.total_price, ei.type,
         COALESCE(ei.unit_cost, lc.unit_cost, 0) AS resolved_unit_cost,
         pay.method AS payment_method, rec.status AS receivable_status,
         ecash.net_cash AS cash_collected, erec.outstanding_amount AS receivable_balance,
         s.username AS staff_username
       FROM exchange_items ei
       JOIN exchanges e ON e.id = ei.exchange_id
       JOIN books b ON b.id = ei.book_id
       ${commonJoins}
       ${costBasisLateralJoin('ei.book_id')}
       WHERE ${unified.conditions.join(' AND ')}
       ORDER BY e.created_at`,
      unified.params,
    ),
  ]);

  function mapExchangeRow(row: Record<string, unknown>, direction: 'incoming' | 'outgoing'): UnifiedTransactionRow {
    const quantity = row.quantity as number;
    const unitPrice = parseFloat(row.unit_price as string);
    const totalPrice = parseFloat(row.total_price as string);
    const netAmount = direction === 'incoming' ? -totalPrice : totalPrice;
    // Incoming (trade-in) legs carry no COGS — see header comment. Outgoing
    // (resale) legs use the persisted/fallback unit cost like ORDER/POS.
    const costAmount = direction === 'incoming'
      ? 0
      : parseFloat((parseFloat((row.resolved_unit_cost as string | number | null) as string ?? '0') * quantity).toFixed(2));
    return {
      transactionDate: row.transaction_date as string,
      transactionType: 'EXCHANGE',
      referenceNumber: row.reference_number as string,
      branch: row.branch as string,
      locationName: (row.location_name as string | null) ?? '',
      customerName: row.customer_name as string,
      bookTitle: row.book_title as string,
      bookIsbn: (row.book_isbn as string | null) ?? '',
      quantity,                       // positive for both directions
      unitPrice,
      discountAmount: 0,              // exchanges don't carry a discount concept
      grossAmount: totalPrice,
      netAmount,
      costAmount,
      grossProfit: parseFloat((netAmount - costAmount).toFixed(2)),
      paymentStatus: mapReceivableStatusToPaymentStatus((row.receivable_status as string | null) ?? null),
      paymentMethod: mapPaymentMethod(row.payment_method as string | null),
      cashCollected: parseFloat((row.cash_collected as string | number | null) as string ?? '0'),
      receivableBalance: parseFloat((row.receivable_balance as string | number | null) as string ?? '0'),
      staffUsername: (row.staff_username as string | null) ?? '',
    };
  }

  const rows: UnifiedTransactionRow[] = [
    ...incomingRes.rows.map(r => mapExchangeRow(r, 'incoming')),
    ...outgoingRes.rows.map(r => mapExchangeRow(r, 'outgoing')),
    ...unifiedRes.rows.map(r => mapExchangeRow(r, (r.type as string) === 'returned' ? 'incoming' : 'outgoing')),
  ];
  return rows;
}

// ── Unified export ────────────────────────────────────────────────────────────

export async function getUnifiedTransactionRows(filters: ReportFilters): Promise<UnifiedTransactionRow[]> {
  const [orderRows, posRows, returnRows, exchangeRows] = await Promise.all([
    getOrderRows(filters),
    getPosRows(filters),
    getReturnRows(filters),
    getExchangeRows(filters),
  ]);
  return [...orderRows, ...posRows, ...returnRows, ...exchangeRows]
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));
}

// ── Unified aggregate summary ─────────────────────────────────────────────────
// Deliberately computed by summing the SAME rows getUnifiedTransactionRows()
// returns (not a hand-written parallel SQL aggregate) — this is what makes
// "1:1 reconciliation" between the Dashboard cards and the CSV export a
// guarantee rather than a hope: they are, quite literally, the same numbers.

export async function getUnifiedFinancialSummary(filters: ReportFilters): Promise<UnifiedFinancialSummary> {
  const rows = await getUnifiedTransactionRows(filters);
  let grossSales = 0, discounts = 0, returnsValue = 0, exchangeDifference = 0, costAmount = 0;
  for (const row of rows) {
    if (row.transactionType === 'ORDER' || row.transactionType === 'POS') {
      grossSales += row.grossAmount;
      discounts += row.discountAmount;
    } else if (row.transactionType === 'RETURN') {
      returnsValue += -row.netAmount; // positive magnitude
    } else if (row.transactionType === 'EXCHANGE') {
      exchangeDifference += row.netAmount;
    }
    costAmount += row.costAmount;
  }
  const netSalesRevenue = parseFloat((grossSales - discounts - returnsValue + exchangeDifference).toFixed(2));
  const roundedCost = parseFloat(costAmount.toFixed(2));
  const grossProfit = parseFloat((netSalesRevenue - roundedCost).toFixed(2));
  const grossMarginPct = netSalesRevenue !== 0 ? parseFloat(((grossProfit / netSalesRevenue) * 100).toFixed(2)) : 0;
  return {
    grossSales: parseFloat(grossSales.toFixed(2)),
    discounts: parseFloat(discounts.toFixed(2)),
    returnsValue: parseFloat(returnsValue.toFixed(2)),
    exchangeDifference: parseFloat(exchangeDifference.toFixed(2)),
    netSalesRevenue,
    costAmount: roundedCost,
    grossProfit,
    grossMarginPct,
    rowCount: rows.length,
  };
}
