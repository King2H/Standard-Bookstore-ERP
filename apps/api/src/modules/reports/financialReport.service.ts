// ── FinancialReportService ──────────────────────────────────────────────────
//
// Dashboard Standardization & Unified Reports Engine.
//
// Single calculation engine shared by the Sales CSV export and the
// Dashboard's Net Sales Revenue / Net Profit (unified) / Gross Profit
// (unified) KPI cards — both read from getUnifiedTransactionRows() (or its
// in-process summary, which is literally SUM() over the same rows), so a
// dashboard total for a given date range can never mathematically diverge
// from the CSV export for that same range: they're the same rows.
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
// This is deliberately additive: it does NOT change lib/profit.service.ts's
// computeNetProfit() (collected-cash revenue recognition for credit sales —
// an existing, separately-tested accounting policy) or any of the existing
// KpiReport fields it feeds. "Net Sales Revenue" here is a distinct,
// invoiced/gross-accrual figure — every qualifying order/POS/return/exchange
// line for the period, regardless of whether a credit sale has been
// collected yet. Both are legitimate, commonly-used financial lenses (cash
// vs accrual); this module's numbers are the ones the CSV export reconciles
// with, by construction.

import { db } from '../../db/index.js';

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
  customerName: string;
  bookTitle: string;
  bookIsbn: string;
  quantity: number;             // positive for ORDER/POS/EXCHANGE; negative for RETURN
  unitPrice: number;
  discountAmount: number;
  grossAmount: number;
  netAmount: number;            // gross − discount for ORDER/POS; −refund for RETURN; ±allowance/sale for EXCHANGE
  paymentStatus: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID';
  paymentMethod: string;
}

export interface UnifiedFinancialSummary {
  grossSales: number;
  discounts: number;
  returnsValue: number;         // positive magnitude
  exchangeDifference: number;   // signed: outgoing − incoming across all exchange line items
  netSalesRevenue: number;      // grossSales − discounts − returnsValue + exchangeDifference
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

// ── ORDER rows ───────────────────────────────────────────────────────────────

async function getOrderRows(filters: ReportFilters): Promise<UnifiedTransactionRow[]> {
  const { conditions, params } = buildDateBranchConditions(filters, 'o');
  conditions.unshift(`o.status NOT IN ('Cancelled','CANCELLED')`);
  const where = 'WHERE ' + conditions.join(' AND ');

  const res = await db.query(
    `SELECT
       TO_CHAR(o.created_at, 'YYYY-MM-DD') AS transaction_date,
       o.order_number AS reference_number,
       br.name AS branch,
       COALESCE(c.full_name, 'Walk-in') AS customer_name,
       b.title AS book_title, b.isbn AS book_isbn,
       oli.quantity, oli.unit_price, oli.discount_amount, oli.total_price,
       o.payment_status,
       opay.payment_method
     FROM order_line_items oli
     JOIN orders o ON o.id = oli.order_id
     JOIN books b ON b.id = oli.book_id
     JOIN branches br ON br.id = o.branch_id
     LEFT JOIN customers c ON c.id = o.customer_id
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
    return {
      transactionDate: row.transaction_date as string,
      transactionType: 'ORDER',
      referenceNumber: row.reference_number as string,
      branch: row.branch as string,
      customerName: row.customer_name as string,
      bookTitle: row.book_title as string,
      bookIsbn: (row.book_isbn as string | null) ?? '',
      quantity, unitPrice, discountAmount, grossAmount, netAmount,
      paymentStatus: mapOrderPaymentStatus(row.payment_status as string),
      paymentMethod: mapPaymentMethod(row.payment_method as string | null),
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
       br.name AS branch,
       COALESCE(c.full_name, 'Walk-in') AS customer_name,
       b.title AS book_title, b.isbn AS book_isbn,
       tli.quantity, tli.unit_price, tli.discount_amount, tli.line_total,
       t.payment_status,
       tpay.method AS payment_method
     FROM transaction_line_items tli
     JOIN transactions t ON t.id = tli.transaction_id
     JOIN books b ON b.id = tli.book_id
     JOIN branches br ON br.id = t.branch_id
     LEFT JOIN customers c ON c.id = t.customer_id
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
    return {
      transactionDate: row.transaction_date as string,
      transactionType: 'POS',
      referenceNumber: row.reference_number as string,
      branch: row.branch as string,
      customerName: row.customer_name as string,
      bookTitle: row.book_title as string,
      bookIsbn: (row.book_isbn as string | null) ?? '',
      quantity, unitPrice, discountAmount, grossAmount, netAmount,
      paymentStatus: mapPosPaymentStatus(row.payment_status as string),
      paymentMethod: mapPaymentMethod(row.payment_method as string | null),
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
       br.name AS branch,
       COALESCE(c.full_name, 'Walk-in') AS customer_name,
       b.title AS book_title, b.isbn AS book_isbn,
       rli.quantity, rli.unit_price, rli.line_refund_amount,
       r.refund_method
     FROM return_line_items rli
     JOIN returns r ON r.id = rli.return_id
     JOIN books b ON b.id = rli.book_id
     JOIN branches br ON br.id = r.branch_id
     LEFT JOIN customers c ON c.id = r.customer_id
     ${where}
     ORDER BY r.created_at`,
    params,
  );

  return res.rows.map((row): UnifiedTransactionRow => {
    const quantity = row.quantity as number;
    const unitPrice = parseFloat(row.unit_price as string);
    const grossAmount = parseFloat((unitPrice * quantity).toFixed(2));
    const refundAmount = parseFloat(row.line_refund_amount as string);
    return {
      transactionDate: row.transaction_date as string,
      transactionType: 'RETURN',
      referenceNumber: row.reference_number as string,
      branch: row.branch as string,
      customerName: row.customer_name as string,
      bookTitle: row.book_title as string,
      bookIsbn: (row.book_isbn as string | null) ?? '',
      quantity: -quantity,            // negative — a return reduces stock/sales
      unitPrice,
      discountAmount: 0,              // returns don't carry a discount concept
      grossAmount,
      netAmount: -refundAmount,       // reduces net sales revenue
      paymentStatus: 'PAID',          // the refund is processed at creation — nothing left outstanding
      paymentMethod: mapPaymentMethod(row.refund_method as string | null),
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

  const [incomingRes, outgoingRes, unifiedRes] = await Promise.all([
    db.query(
      `SELECT
         TO_CHAR(e.created_at, 'YYYY-MM-DD') AS transaction_date,
         e.exchange_reference AS reference_number, br.name AS branch,
         COALESCE(c.full_name, 'Walk-in') AS customer_name,
         b.title AS book_title, b.isbn AS book_isbn,
         ei.quantity, ei.evaluated_unit_price AS unit_price, ei.total_price,
         pay.method AS payment_method, rec.status AS receivable_status
       FROM exchange_incoming_items ei
       JOIN exchanges e ON e.id = ei.exchange_id
       JOIN books b ON b.id = ei.book_id
       JOIN branches br ON br.id = e.branch_id
       LEFT JOIN customers c ON c.id = e.customer_id
       ${paymentMethodLateral}
       ${receivableLateral}
       WHERE ${legacyIncoming.conditions.join(' AND ')}
       ORDER BY e.created_at`,
      legacyIncoming.params,
    ),
    db.query(
      `SELECT
         TO_CHAR(e.created_at, 'YYYY-MM-DD') AS transaction_date,
         e.exchange_reference AS reference_number, br.name AS branch,
         COALESCE(c.full_name, 'Walk-in') AS customer_name,
         b.title AS book_title, b.isbn AS book_isbn,
         eo.quantity, eo.selling_unit_price AS unit_price, eo.total_price,
         pay.method AS payment_method, rec.status AS receivable_status
       FROM exchange_outgoing_items eo
       JOIN exchanges e ON e.id = eo.exchange_id
       JOIN books b ON b.id = eo.book_id
       JOIN branches br ON br.id = e.branch_id
       LEFT JOIN customers c ON c.id = e.customer_id
       ${paymentMethodLateral}
       ${receivableLateral}
       WHERE ${legacyOutgoing.conditions.join(' AND ')}
       ORDER BY e.created_at`,
      legacyOutgoing.params,
    ),
    db.query(
      `SELECT
         TO_CHAR(e.created_at, 'YYYY-MM-DD') AS transaction_date,
         e.exchange_reference AS reference_number, br.name AS branch,
         COALESCE(c.full_name, 'Walk-in') AS customer_name,
         b.title AS book_title, b.isbn AS book_isbn,
         ei.quantity, ei.unit_price, ei.total_price, ei.type,
         pay.method AS payment_method, rec.status AS receivable_status
       FROM exchange_items ei
       JOIN exchanges e ON e.id = ei.exchange_id
       JOIN books b ON b.id = ei.book_id
       JOIN branches br ON br.id = e.branch_id
       LEFT JOIN customers c ON c.id = e.customer_id
       ${paymentMethodLateral}
       ${receivableLateral}
       WHERE ${unified.conditions.join(' AND ')}
       ORDER BY e.created_at`,
      unified.params,
    ),
  ]);

  function mapExchangeRow(row: Record<string, unknown>, direction: 'incoming' | 'outgoing'): UnifiedTransactionRow {
    const quantity = row.quantity as number;
    const unitPrice = parseFloat(row.unit_price as string);
    const totalPrice = parseFloat(row.total_price as string);
    return {
      transactionDate: row.transaction_date as string,
      transactionType: 'EXCHANGE',
      referenceNumber: row.reference_number as string,
      branch: row.branch as string,
      customerName: row.customer_name as string,
      bookTitle: row.book_title as string,
      bookIsbn: (row.book_isbn as string | null) ?? '',
      quantity,                       // positive for both directions
      unitPrice,
      discountAmount: 0,              // exchanges don't carry a discount concept
      grossAmount: totalPrice,
      netAmount: direction === 'incoming' ? -totalPrice : totalPrice,
      paymentStatus: mapReceivableStatusToPaymentStatus((row.receivable_status as string | null) ?? null),
      paymentMethod: mapPaymentMethod(row.payment_method as string | null),
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
  let grossSales = 0, discounts = 0, returnsValue = 0, exchangeDifference = 0;
  for (const row of rows) {
    if (row.transactionType === 'ORDER' || row.transactionType === 'POS') {
      grossSales += row.grossAmount;
      discounts += row.discountAmount;
    } else if (row.transactionType === 'RETURN') {
      returnsValue += -row.netAmount; // positive magnitude
    } else if (row.transactionType === 'EXCHANGE') {
      exchangeDifference += row.netAmount;
    }
  }
  const netSalesRevenue = parseFloat((grossSales - discounts - returnsValue + exchangeDifference).toFixed(2));
  return {
    grossSales: parseFloat(grossSales.toFixed(2)),
    discounts: parseFloat(discounts.toFixed(2)),
    returnsValue: parseFloat(returnsValue.toFixed(2)),
    exchangeDifference: parseFloat(exchangeDifference.toFixed(2)),
    netSalesRevenue,
    rowCount: rows.length,
  };
}
