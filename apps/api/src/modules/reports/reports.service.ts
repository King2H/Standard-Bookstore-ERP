import { Money } from '@bms/shared';
import { db } from '../../db/index.js';
import { costBasisLateralJoin } from '../../lib/costBasis.js';

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

export interface InventoryReport {
  summary: {
    totalBooks: number;
    totalStockUnits: number;
    availableStock: number;
    reservedStock: number;
    lowStockItems: number;
    outOfStockItems: number;
  };
  lowStockItems: Array<{ bookId: number; title: string; locationId: number; locationName: string; quantity: number; reorderPoint: number }>;
  topSellingBooks: Array<{ bookId: number; title: string; unitsSold: number; revenue: number }>;
  stockMovement: Array<{ period: string; stockIn: number; stockOut: number }>;
}

export interface CustomerReport {
  summary: {
    totalCustomers: number;
    activeCustomers: number;
    repeatCustomers: number;
    newCustomersInPeriod: number;
  };
  topCustomers: Array<{ customerId: number; fullName: string; totalSpend: number; orderCount: number }>;
  byPeriod: Array<{ period: string; newCustomers: number }>;
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

// ── Inventory Report ──────────────────────────────────────────────────────────

export async function getInventoryReport(filters: ReportFilters): Promise<InventoryReport> {
  const groupBy = filters.groupBy ?? 'day';

  // Build location filter via branch
  const params: unknown[] = [];
  const invConditions: string[] = [];
  if (filters.branchId) {
    params.push(filters.branchId);
    invConditions.push(`l.branch_id = $${params.length}`);
  }
  const invWhere = invConditions.length ? 'WHERE ' + invConditions.join(' AND ') : '';

  const summaryRes = await db.query(
    `SELECT
       COUNT(DISTINCT i.book_id)::INTEGER                                                          AS total_books,
       COALESCE(SUM(i.quantity), 0)::INTEGER                                                       AS total_units,
       -- Available stock = quantity, NOT quantity - reservations: confirm()
       -- already physically deducts stock via stockOut() (order-payment-
       -- unification spec, 3.5); the reservation row is bookkeeping, not a
       -- second hold on top of the physical deduction.
       COALESCE(SUM(i.quantity), 0)::INTEGER                                                       AS available_stock,
       -- Reserved stock = SUM of all active reservations (Requirement 2.16)
       COALESCE(SUM(COALESCE(r.reserved, 0)), 0)::INTEGER                                         AS reserved_stock,
       COUNT(CASE WHEN i.quantity <= i.reorder_point AND i.quantity > 0 THEN 1 END)::INTEGER       AS low_stock,
       COUNT(CASE WHEN i.quantity = 0 THEN 1 END)::INTEGER                                        AS out_of_stock
     FROM inventory i
     JOIN locations l ON l.id = i.location_id
     LEFT JOIN (
       SELECT book_id, location_id, COALESCE(SUM(quantity), 0) AS reserved
       FROM inventory_reservations
       WHERE status = 'reserved'
       GROUP BY book_id, location_id
     ) r ON r.book_id = i.book_id AND r.location_id = i.location_id
     ${invWhere}`,
    params,
  );

  const lowStockRes = await db.query(
    `SELECT
       i.book_id,
       b.title,
       i.location_id,
       l.name AS location_name,
       i.quantity,
       i.reorder_point
     FROM inventory i
     JOIN books b ON b.id = i.book_id
     JOIN locations l ON l.id = i.location_id
     ${invWhere ? invWhere + ' AND i.quantity <= i.reorder_point' : 'WHERE i.quantity <= i.reorder_point'}
     ORDER BY i.quantity ASC
     LIMIT 50`,
    params,
  );

  // Top selling books from POS (transaction_line_items)
  const topSellingParams: unknown[] = [];
  const topSellingConds: string[] = ["t.status = 'completed'"];
  if (filters.branchId) {
    topSellingParams.push(filters.branchId);
    topSellingConds.push(`t.branch_id = $${topSellingParams.length}`);
  }
  if (filters.dateFrom) {
    topSellingParams.push(filters.dateFrom);
    topSellingConds.push(`t.created_at >= $${topSellingParams.length}`);
  }
  if (filters.dateTo) {
    topSellingParams.push(filters.dateTo);
    topSellingConds.push(`t.created_at <= $${topSellingParams.length}`);
  }
  const topSellingWhere = 'WHERE ' + topSellingConds.join(' AND ');

  const topSellingRes = await db.query(
    `SELECT
       li.book_id,
       b.title,
       SUM(li.quantity)::INTEGER                AS units_sold,
       COALESCE(SUM(li.line_total), 0)::NUMERIC AS revenue
     FROM transaction_line_items li
     JOIN transactions t ON t.id = li.transaction_id
     JOIN books b ON b.id = li.book_id
     ${topSellingWhere}
     GROUP BY li.book_id, b.title
     ORDER BY units_sold DESC
     LIMIT 20`,
    topSellingParams,
  );

  // Stock movement from inventory_history
  const histParams: unknown[] = [];
  const histConds: string[] = [];
  if (filters.branchId) {
    histParams.push(filters.branchId);
    histConds.push(`l.branch_id = $${histParams.length}`);
  }
  if (filters.dateFrom) {
    histParams.push(filters.dateFrom);
    histConds.push(`ih.created_at >= $${histParams.length}`);
  }
  if (filters.dateTo) {
    histParams.push(filters.dateTo);
    histConds.push(`ih.created_at <= $${histParams.length}`);
  }
  const histWhere = histConds.length ? 'WHERE ' + histConds.join(' AND ') : '';
  const truncExpr = `date_trunc('${groupBy}', ih.created_at)`;

  const movementRes = await db.query(
    `SELECT
       ${truncExpr}::TEXT                                                AS period,
       COALESCE(SUM(CASE WHEN ih.delta > 0 THEN ih.delta ELSE 0 END), 0)::INTEGER  AS stock_in,
       COALESCE(SUM(CASE WHEN ih.delta < 0 THEN ABS(ih.delta) ELSE 0 END), 0)::INTEGER AS stock_out
     FROM inventory_history ih
     JOIN locations l ON l.id = ih.location_id
     ${histWhere}
     GROUP BY ${truncExpr}
     ORDER BY ${truncExpr}`,
    histParams,
  );

  const s = summaryRes.rows[0];

  return {
    summary: {
      totalBooks:     s.total_books,
      totalStockUnits: s.total_units,
      availableStock: s.available_stock,
      reservedStock:  s.reserved_stock,
      lowStockItems:  s.low_stock,
      outOfStockItems: s.out_of_stock,
    },
    lowStockItems: lowStockRes.rows.map(r => ({
      bookId:       r.book_id,
      title:        r.title,
      locationId:   r.location_id,
      locationName: r.location_name,
      quantity:     r.quantity,
      reorderPoint: r.reorder_point,
    })),
    topSellingBooks: topSellingRes.rows.map(r => ({
      bookId:    r.book_id,
      title:     r.title,
      unitsSold: r.units_sold,
      revenue:   parseFloat(r.revenue),
    })),
    stockMovement: movementRes.rows.map(r => ({
      period:   r.period,
      stockIn:  r.stock_in,
      stockOut: r.stock_out,
    })),
  };
}

// Module 9 cleanup: removed getInventoryExportRows() (v1, per-book-per-
// location ledger with opening/closing stock) and its InventoryExportRow
// interface. Dead code — no route ever called it; /reports/inventory/export
// has always been wired to getInventoryExportRowsV2() below (the 11-column
// schema matching INVENTORY_COLUMNS in csvBuilder.ts). Identified during
// the Module 7 export-integrity audit, removed here per that module's
// deferred cleanup note.

// ── Customer Report ───────────────────────────────────────────────────────────

export async function getCustomerReport(filters: ReportFilters): Promise<CustomerReport> {
  const groupBy = filters.groupBy ?? 'day';

  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filters.branchId) {
    params.push(filters.branchId);
    conditions.push(`c.branch_id = $${params.length}`);
  }
  const baseWhere = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const summaryRes = await db.query(
    `SELECT
       COUNT(*)::INTEGER                                                                AS total_customers,
       COUNT(CASE WHEN c.is_active THEN 1 END)::INTEGER                                AS active_customers
     FROM customers c ${baseWhere}`,
    params,
  );

  // Repeat customers: customers with more than 1 order
  const repeatParams = [...params];
  const repeatConds = [...conditions];
  if (filters.dateFrom) {
    repeatParams.push(filters.dateFrom);
    repeatConds.push(`o.created_at >= $${repeatParams.length}`);
  }
  if (filters.dateTo) {
    repeatParams.push(filters.dateTo);
    repeatConds.push(`o.created_at <= $${repeatParams.length}`);
  }
  const repeatWhere = repeatConds.length ? 'WHERE ' + repeatConds.join(' AND ') : '';

  const repeatRes = await db.query(
    `SELECT COUNT(DISTINCT o.customer_id)::INTEGER AS repeat_customers
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     ${repeatWhere}
     AND o.customer_id IN (
       SELECT customer_id FROM orders WHERE customer_id IS NOT NULL GROUP BY customer_id HAVING COUNT(*) > 1
     )`,
    repeatParams,
  );

  // New customers in period
  const newParams: unknown[] = [];
  const newConds: string[] = [];
  if (filters.branchId) {
    newParams.push(filters.branchId);
    newConds.push(`c.branch_id = $${newParams.length}`);
  }
  if (filters.dateFrom) {
    newParams.push(filters.dateFrom);
    newConds.push(`c.created_at >= $${newParams.length}`);
  }
  if (filters.dateTo) {
    newParams.push(filters.dateTo);
    newConds.push(`c.created_at <= $${newParams.length}`);
  }
  const newWhere = newConds.length ? 'WHERE ' + newConds.join(' AND ') : '';

  const newCustRes = await db.query(
    `SELECT COUNT(*)::INTEGER AS new_customers FROM customers c ${newWhere}`,
    newParams,
  );

  // Top customers by spend (orders)
  const topParams = [...params];
  const topConds = [...conditions];
  if (filters.dateFrom) { topParams.push(filters.dateFrom); topConds.push(`o.created_at >= $${topParams.length}`); }
  if (filters.dateTo)   { topParams.push(filters.dateTo);   topConds.push(`o.created_at <= $${topParams.length}`); }
  const topWhere = topConds.length ? 'WHERE ' + topConds.join(' AND ') + " AND o.status != 'Cancelled' AND o.customer_id IS NOT NULL" : "WHERE o.status != 'Cancelled' AND o.customer_id IS NOT NULL";

  const topRes = await db.query(
    `SELECT
       c.id                                       AS customer_id,
       c.full_name,
       COALESCE(SUM(o.total), 0)::NUMERIC         AS total_spend,
       COUNT(o.id)::INTEGER                       AS order_count
     FROM customers c
     JOIN orders o ON o.customer_id = c.id
     ${topWhere}
     GROUP BY c.id, c.full_name
     ORDER BY total_spend DESC
     LIMIT 20`,
    topParams,
  );

  // New customers by period
  const truncExpr = `date_trunc('${groupBy}', c.created_at)`;
  const periodRes = await db.query(
    `SELECT
       ${truncExpr}::TEXT        AS period,
       COUNT(*)::INTEGER         AS new_customers
     FROM customers c ${newWhere}
     GROUP BY ${truncExpr}
     ORDER BY ${truncExpr}`,
    newParams,
  );

  const s = summaryRes.rows[0];

  return {
    summary: {
      totalCustomers:      s.total_customers,
      activeCustomers:     s.active_customers,
      repeatCustomers:     repeatRes.rows[0]?.repeat_customers ?? 0,
      newCustomersInPeriod: newCustRes.rows[0]?.new_customers ?? 0,
    },
    topCustomers: topRes.rows.map(r => ({
      customerId:  r.customer_id,
      fullName:    r.full_name,
      totalSpend:  parseFloat(r.total_spend),
      orderCount:  r.order_count,
    })),
    byPeriod: periodRes.rows.map(r => ({
      period:       r.period,
      newCustomers: r.new_customers,
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

// ── Receivables Export Rows ───────────────────────────────────────────────────

export interface ReceivablesExportRow {
  order_reference: string;
  date: string;
  customer_name: string;
  original_amount: number;
  collected_amount: number;
  outstanding_amount: number;
  due_date: string;
  days_overdue: number;
  payment_status: string;
}

export async function getReceivablesExportRows(filters: ReportFilters): Promise<ReceivablesExportRow[]> {
  // Module 7 fix: this export was hardcoded to source_type = 'order_credit_sale',
  // silently dropping all pos_credit_sale and exchange_difference receivables
  // from the CSV — an incomplete AR export compared to the on-screen
  // Receivables page, which lists all three source types. Export every
  // source type; use receivables.source_ref_id (the human-readable
  // reference stamped at creation time for every source type — order
  // number, POS transaction number, or exchange reference) instead of
  // joining orders specifically, which only resolved for order_credit_sale
  // rows and left the reference blank/'N/A' for the other two types.
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filters.branchId) { params.push(filters.branchId); conditions.push(`r.branch_id = $${params.length}`); }
  if (filters.dateFrom) { params.push(filters.dateFrom); conditions.push(`r.created_at::date >= $${params.length}::date`); }
  if (filters.dateTo)   { params.push(filters.dateTo);   conditions.push(`r.created_at::date <= $${params.length}::date`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const res = await db.query(
    `SELECT
       TO_CHAR(r.created_at, 'YYYY-MM-DD') AS date_str,
       r.original_amount,
       r.outstanding_amount,
       COALESCE(r.written_off_amount, 0) + COALESCE(r.cancelled_amount, 0) + r.credited_amount AS written_off_amount,
       TO_CHAR(r.due_date, 'YYYY-MM-DD') AS due_date_str,
       r.status,
       GREATEST(0, EXTRACT(DAY FROM now() - r.due_date)::int) AS days_overdue,
       r.source_ref_id AS order_reference,
       COALESCE(c.full_name, 'Unknown') AS customer_name,
       r.status AS payment_status
     FROM receivables r
     LEFT JOIN customers c ON c.id = r.customer_id
     ${where}
     ORDER BY r.due_date ASC NULLS LAST, r.created_at DESC`,
    params,
  );

  return (res.rows as Record<string, unknown>[]).map(row => {
    const original  = parseFloat(row.original_amount   as string);
    const outstanding = parseFloat(row.outstanding_amount as string);
    return {
      order_reference:    row.order_reference as string,
      // TO_CHAR(...) SQL-side strings — never a JS Date/toISOString()
      // round-trip (that pattern drifts a day off near midnight in
      // non-UTC timezones).
      date:               row.date_str as string,
      customer_name:      row.customer_name as string,
      original_amount:    original,
      // A write-off, a cancelled sale or a return closes the balance without collecting it.
      collected_amount:   Money.of(row.original_amount as string).minus(row.outstanding_amount as string).minus(row.written_off_amount as string).toNumber(),
      outstanding_amount: outstanding,
      due_date:           (row.due_date_str as string | null) ?? '',
      days_overdue:       row.days_overdue as number ?? 0,
      payment_status:     row.payment_status as string,
    };
  });
}

// ── Inventory Export V2 (11-column schema) ────────────────────────────────────

export interface InventoryExportRowV2 {
  book_code: string;
  isbn: string;
  title: string;
  author: string;
  category: string;
  publisher: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
  unit_cost: number;
  last_movement_date: string;
  // Prompt 2 — Inventory Valuation Report field list additions.
  average_cost: number;
  inventory_value: number;
  last_purchase_cost: number;
  last_selling_price: number;
}

export async function getInventoryExportRowsV2(filters: ReportFilters): Promise<InventoryExportRowV2[]> {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filters.branchId) { params.push(filters.branchId); conditions.push(`l.branch_id = $${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const reservationJoin = `LEFT JOIN (
         SELECT book_id, location_id, SUM(quantity)::int AS reserved
         FROM inventory_reservations WHERE status = 'reserved'
         GROUP BY book_id, location_id
       ) res ON res.book_id = i.book_id AND res.location_id = i.location_id`;

  // available is always i.quantity: confirm() already physically deducts stock
  // via stockOut() (order-payment-unification spec, 3.5), so quantity_reserved
  // is informational bookkeeping, not a second hold to subtract.
  const reservedExpr  = `COALESCE(res.reserved, 0)::int`;
  const availableExpr = `i.quantity::int`;
  const groupByReserved = `, res.reserved`;

  const res = await db.query(
    `SELECT
       i.book_id,
       COALESCE(b.sku, b.isbn)                                             AS book_code,
       b.isbn,
       b.title,
       COALESCE(b.publisher, '')                                           AS publisher,
       COALESCE(
         string_agg(DISTINCT a.name, ', ' ORDER BY a.name),
         ''
       )                                                                   AS author,
       COALESCE(
         (SELECT string_agg(cat.name, ', ' ORDER BY cat.name)
          FROM book_categories bc2
          JOIN categories cat ON cat.id = bc2.category_id
          WHERE bc2.book_id = b.id),
         ''
       )                                                                   AS category,
       i.quantity                                                          AS quantity_on_hand,
       ${reservedExpr}                                                     AS quantity_reserved,
       ${availableExpr}                                                    AS quantity_available,
       -- Inventory Valuation Policy: this per-(book,location) row's own
       -- Weighted Average Cost is the authoritative valuation for what's
       -- actually on hand here — more accurate than costBasis.ts's
       -- most-recent-cost lookup (which isn't location-aware and doesn't
       -- reflect blended receipts). Falls back to it only when average_cost
       -- is still 0 (never received any valued stock at this location yet).
       COALESCE(NULLIF(i.average_cost, 0), lc.unit_cost, 0)::NUMERIC       AS unit_cost,
       i.inventory_value,
       TO_CHAR(
         (SELECT MAX(ih.created_at)
          FROM inventory_history ih
          WHERE ih.book_id = i.book_id AND ih.location_id = i.location_id),
         'YYYY-MM-DD'
       ) AS last_movement_date_str,
       (SELECT pli.unit_cost FROM po_line_items pli
        WHERE pli.book_id = b.id ORDER BY pli.id DESC LIMIT 1)              AS last_purchase_cost,
       COALESCE(bbp.price, b.default_price)                                 AS last_selling_price
     FROM inventory i
     JOIN books b ON b.id = i.book_id
     JOIN locations l ON l.id = i.location_id
     LEFT JOIN book_authors ba ON ba.book_id = b.id
     LEFT JOIN authors a ON a.id = ba.author_id
     LEFT JOIN book_branch_prices bbp ON bbp.book_id = b.id AND bbp.branch_id = l.branch_id
       AND bbp.format_id = 0 AND bbp.edition_id = 0
     ${reservationJoin}
     ${costBasisLateralJoin('b.id')}
     ${where}
     GROUP BY b.id, i.book_id, b.sku, b.isbn, b.title, b.publisher, i.location_id,
              i.quantity, i.average_cost, i.inventory_value${groupByReserved}, lc.unit_cost,
              bbp.price, b.default_price
     ORDER BY b.title ASC`,
    params,
  );

  return (res.rows as Record<string, unknown>[]).map(row => ({
    book_code:          (row.book_code as string | null) ?? '',
    isbn:               (row.isbn as string | null) ?? '',
    title:              row.title as string,
    author:             (row.author as string | null) ?? '',
    category:           (row.category as string | null) ?? '',
    publisher:          (row.publisher as string | null) ?? '',
    quantity_on_hand:   row.quantity_on_hand as number,
    quantity_reserved:  row.quantity_reserved as number,
    quantity_available: row.quantity_available as number,
    unit_cost:          parseFloat(row.unit_cost as string),
    // TO_CHAR(...) SQL-side string — never a JS Date/toISOString()
    // round-trip (that pattern drifts a day off near midnight in non-UTC
    // timezones).
    last_movement_date: (row.last_movement_date_str as string | null) ?? '',
    // Prompt 2 — Inventory Valuation Report additions. inventory_value is
    // Prompt 1's generated column (quantity × average_cost); unit_cost
    // above already IS "Average Cost" (per-location weighted average, with
    // costBasis.ts fallback only when a location has never received valued
    // stock) — surfaced again under its own name for the Valuation Report's
    // exact field list.
    average_cost:       parseFloat(row.unit_cost as string),
    inventory_value:    parseFloat((row.inventory_value as string | number | null) as string ?? '0'),
    last_purchase_cost: row.last_purchase_cost != null ? parseFloat(row.last_purchase_cost as string) : 0,
    last_selling_price: row.last_selling_price != null ? parseFloat(row.last_selling_price as string) : 0,
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

// ── Receivables Aging Report (Prompt 2) ─────────────────────────────────────
// Genuinely new — no aging-bucket concept existed anywhere previously. The
// same bucket boundaries and query back both the dashboard's Receivables
// Aging Summary widget and this export, so they can't drift apart.

export type AgingBucket = 'Current' | '1-30' | '31-60' | '61-90' | '90+';

export interface ReceivablesAgingRow {
  customer: string;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  outstandingAmount: number;
  agingBucket: AgingBucket;
  lastPaymentDate: string;
}

function bucketForDaysOverdue(days: number): AgingBucket {
  if (days <= 0) return 'Current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

export async function getReceivablesAgingReport(filters: ReportFilters): Promise<{
  rows: ReceivablesAgingRow[];
  byBucket: Array<{ bucket: AgingBucket; count: number; totalOutstanding: number }>;
}> {
  const params: unknown[] = [];
  const conditions: string[] = [`r.status IN ('Pending', 'PartiallyPaid', 'Overdue')`];
  if (filters.branchId) { params.push(filters.branchId); conditions.push(`r.branch_id = $${params.length}`); }
  const where = 'WHERE ' + conditions.join(' AND ');

  const res = await db.query(
    `SELECT
       COALESCE(c.full_name, 'Unknown') AS customer_name,
       r.source_ref_id AS invoice_no,
       TO_CHAR(r.created_at, 'YYYY-MM-DD') AS invoice_date,
       TO_CHAR(r.due_date, 'YYYY-MM-DD') AS due_date_str,
       r.outstanding_amount, r.original_amount,
       -- Bug fix: due_date is a DATE column, so date - date already yields
       -- an integer day-count in Postgres — wrapping it in EXTRACT(DAY FROM
       -- ...) throws "function extract(unknown, integer) does not exist"
       -- (EXTRACT expects a timestamp/interval, not an integer), which was
       -- crashing this endpoint with a 500 on every call. GREATEST ignores
       -- NULL args, so a NULL due_date still correctly reads as 0 (Current).
       GREATEST(0, (CURRENT_DATE - r.due_date))::int AS days_overdue,
       -- Best-effort: this row is only ever updated when a payment is
       -- applied (updateReceivableOnPayment()) — no dedicated payment-
       -- history table exists per receivable, so updated_at is the closest
       -- available signal, and only shown once a payment has actually
       -- reduced the balance below the original amount.
       CASE WHEN r.outstanding_amount < r.original_amount
            THEN TO_CHAR(r.updated_at, 'YYYY-MM-DD') ELSE NULL END AS last_payment_date_str
     FROM receivables r
     LEFT JOIN customers c ON c.id = r.customer_id
     ${where}
     ORDER BY days_overdue DESC, r.due_date ASC NULLS LAST`,
    params,
  );

  const rows: ReceivablesAgingRow[] = (res.rows as Record<string, unknown>[]).map(row => ({
    customer:           row.customer_name as string,
    invoiceNo:          row.invoice_no as string,
    invoiceDate:        row.invoice_date as string,
    dueDate:            (row.due_date_str as string | null) ?? '',
    outstandingAmount:  parseFloat(row.outstanding_amount as string),
    agingBucket:        bucketForDaysOverdue(row.days_overdue as number),
    lastPaymentDate:    (row.last_payment_date_str as string | null) ?? '',
  }));

  const bucketOrder: AgingBucket[] = ['Current', '1-30', '31-60', '61-90', '90+'];
  const byBucket = bucketOrder.map(bucket => {
    const inBucket = rows.filter(r => r.agingBucket === bucket);
    return {
      bucket,
      count: inBucket.length,
      totalOutstanding: round2(inBucket.reduce((s, r) => s + r.outstandingAmount, 0)),
    };
  });

  return { rows, byBucket };
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
