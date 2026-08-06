import { db } from '../../db/index.js';
import { computeNetProfit } from '../../lib/profit.service.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReportFilters {
  branchId?: number;
  dateFrom?: string;
  dateTo?: string;
  groupBy?: 'day' | 'week' | 'month';
}

export interface SalesReportRow {
  period: string;
  totalSales: number;
  totalOrders: number;
  averageOrderValue: number;
}

export interface SalesReport {
  summary: {
    totalSales: number;
    totalOrders: number;
    averageOrderValue: number;
    totalPosSales: number;
    totalPosTransactions: number;
    // Net profit breakdown fields (Bug 2 fix — computeNetProfit integration)
    netProfit?: number;
    purchaseCost?: number;
    totalDiscounts?: number;
    fulfilledRevenue?: number;
    outstandingReceivables?: number;
    cashSalesRevenue?: number;
    creditSalesRevenue?: number;
  };
  byPeriod: SalesReportRow[];
  byBranch: Array<{ branchId: number; branchName: string; totalSales: number; totalOrders: number }>;
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

export interface KpiReport {
  dailySales: number;
  monthlySales: number;
  dailyRevenue: number;
  monthlyRevenue: number;
  averageOrderValue: number;
  totalActiveCustomers: number;
  lowStockAlerts: number;
  pendingOrders: number;
  totalExchangesToday: number;
  outstandingBalance: number;
  // Net profit breakdown fields (Bug 2 fix — computeNetProfit integration)
  netProfit: number;
  fulfilledRevenue: number;
  outstandingReceivables: number;
  cashSalesRevenue: number;
  creditSalesRevenue: number;
  collectedCreditRevenue: number;
  purchaseCost: number;
  totalDiscounts: number;
  // Executive financial KPIs
  procurementExpense: number;   // SUM of received/closed PO total_amount (current month)
  grossProfit: number;          // fulfilledRevenue - purchaseCost (before returns/exchanges)
  dailyNetProfit: number;       // today's net profit
  monthlyNetProfit: number;     // current month net profit
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dateTrunc(groupBy: 'day' | 'week' | 'month'): string {
  return `date_trunc('${groupBy}', created_at)`;
}

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
// ── Sales Report ──────────────────────────────────────────────────────────────

export async function getSalesReport(filters: ReportFilters): Promise<SalesReport> {
  const groupBy = filters.groupBy ?? 'day';
  const truncExpr = `date_trunc('${groupBy}', o.created_at)`;

  const { conditions: oConds, params: oParams } = buildDateConditions(filters, 'o');
  const cancelledStatuses = `('Cancelled','CANCELLED')`;
  const oWhere = oConds.length
    ? 'WHERE ' + oConds.join(' AND ') + ` AND o.status NOT IN ${cancelledStatuses}`
    : `WHERE o.status NOT IN ${cancelledStatuses}`;

  // Orders summary
  const summaryRes = await db.query(
    `SELECT
       COALESCE(SUM(o.total), 0)::NUMERIC AS total_sales,
       COUNT(*)::INTEGER                  AS total_orders,
       COALESCE(AVG(o.total), 0)::NUMERIC AS avg_order_value
     FROM orders o ${oWhere}`,
    oParams,
  );

  // POS summary (same date/branch filters but on transactions table)
  const { conditions: tConds, params: tParams } = buildDateConditions(filters, 't');
  const tWhere = tConds.length ? 'WHERE ' + tConds.join(' AND ') + " AND t.status = 'completed'" : "WHERE t.status = 'completed'";
  const posRes = await db.query(
    `SELECT
       COALESCE(SUM(t.grand_total), 0)::NUMERIC AS total_pos_sales,
       COUNT(*)::INTEGER                         AS total_pos_transactions
     FROM transactions t ${tWhere}`,
    tParams,
  );

  // By period
  const periodRes = await db.query(
    `SELECT
       ${truncExpr}::TEXT                        AS period,
       COALESCE(SUM(o.total), 0)::NUMERIC        AS total_sales,
       COUNT(*)::INTEGER                         AS total_orders,
       COALESCE(AVG(o.total), 0)::NUMERIC        AS avg_order_value
     FROM orders o ${oWhere}
     GROUP BY ${truncExpr}
     ORDER BY ${truncExpr}`,
    oParams,
  );

  // By branch
  const branchRes = await db.query(
    `SELECT
       o.branch_id,
       b.name                                    AS branch_name,
       COALESCE(SUM(o.total), 0)::NUMERIC        AS total_sales,
       COUNT(*)::INTEGER                         AS total_orders
     FROM orders o
     JOIN branches b ON b.id = o.branch_id
     ${oWhere}
     GROUP BY o.branch_id, b.name
     ORDER BY total_sales DESC`,
    oParams,
  );

  const s = summaryRes.rows[0];
  const p = posRes.rows[0];

  // Bug 2 fix: add net profit breakdown using the shared profit module
  const profitResult = await computeNetProfit({
    branchId: filters.branchId,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
  });

  return {
    summary: {
      totalSales:           parseFloat(s.total_sales),
      totalOrders:          s.total_orders,
      averageOrderValue:    parseFloat(s.avg_order_value),
      totalPosSales:        parseFloat(p.total_pos_sales),
      totalPosTransactions: p.total_pos_transactions,
      // Net profit breakdown fields
      netProfit:              profitResult.netProfit,
      purchaseCost:           profitResult.purchaseCost,
      totalDiscounts:         profitResult.totalDiscounts,
      fulfilledRevenue:       profitResult.fulfilledRevenue,
      outstandingReceivables: profitResult.outstandingReceivables,
      cashSalesRevenue:       profitResult.cashSalesRevenue,
      creditSalesRevenue:     profitResult.creditSalesRevenue,
    },
    byPeriod: periodRes.rows.map(r => ({
      period:            r.period,
      totalSales:        parseFloat(r.total_sales),
      totalOrders:       r.total_orders,
      averageOrderValue: parseFloat(r.avg_order_value),
    })),
    byBranch: branchRes.rows.map(r => ({
      branchId:    r.branch_id,
      branchName:  r.branch_name,
      totalSales:  parseFloat(r.total_sales),
      totalOrders: r.total_orders,
    })),
  };
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
    conditions.push(`op.processed_at >= $${params.length}`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    conditions.push(`op.processed_at <= $${params.length}`);
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

  const s = summaryRes.rows[0];
  const totalRefunded = parseFloat(refundRes.rows[0].total_refunded);

  return {
    summary: {
      totalCollected:  parseFloat(s.total_collected),
      totalRefunded,
      netCollected:    parseFloat(s.total_collected) - totalRefunded,
      pendingPayments: parseFloat(s.pending_payments),
    },
    byMethod: (() => {
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
      return Object.values(byMethodMerged).sort((a, b) => b.total - a.total);
    })(),
    byPeriod: byPeriodRes.rows.map(r => ({
      period:    r.period,
      collected: parseFloat(r.collected),
      refunded:  parseFloat(r.refunded),
    })),
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
       -- Available stock = quantity - active reservations (Requirement 2.16)
       COALESCE(SUM(i.quantity - COALESCE(r.reserved, 0)), 0)::INTEGER                            AS available_stock,
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

// ── Inventory Export — full per-book-per-location ledger ──────────────────────
// Requirement 2.17 — Excel report columns:
//   Book | Location | Opening Stock | Stock In | Stock Out | Reserved | Returned | Damaged | Closing Stock

export interface InventoryExportRow {
  bookId: number;
  bookTitle: string;
  bookIsbn: string;
  locationId: number;
  locationName: string;
  branchId: number;
  openingStock: number;
  stockIn: number;
  stockOut: number;
  reserved: number;
  returned: number;
  damaged: number;
  closingStock: number;
}

export async function getInventoryExportRows(filters: ReportFilters): Promise<InventoryExportRow[]> {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (filters.branchId) {
    params.push(filters.branchId);
    conditions.push(`l.branch_id = $${params.length}`);
  }

  // Period params for history queries
  let dateFromParam = '';
  let dateToParam = '';
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    dateFromParam = `$${params.length}`;
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    dateToParam = `$${params.length}`;
  }

  const invWhere = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  // Check whether inventory_reservations table exists
  const hasResTable = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'inventory_reservations' LIMIT 1`,
  );
  const hasReservations = hasResTable.rows.length > 0;

  // Build history date filter (applied to inventory_history for the period)
  const histConditions = [...conditions.map(c => c.replace('l.branch_id', 'lh.branch_id'))];
  if (filters.dateFrom) histConditions.push(`ih.created_at >= ${dateFromParam}`);
  if (filters.dateTo)   histConditions.push(`ih.created_at <= ${dateToParam}`);
  const histWhere = histConditions.length ? 'WHERE ' + histConditions.join(' AND ') : '';

  // Get all inventory rows (closing stock = current quantity)
  const invRes = await db.query(
    `SELECT
       i.book_id,
       b.title      AS book_title,
       b.isbn       AS book_isbn,
       i.location_id,
       l.name       AS location_name,
       l.branch_id,
       i.quantity   AS closing_stock,
       COALESCE(i.damaged_quantity, 0)::int AS damaged
     FROM inventory i
     JOIN books b ON b.id = i.book_id
     JOIN locations l ON l.id = i.location_id
     ${invWhere}
     ORDER BY b.title ASC, l.name ASC`,
    params,
  );

  if (!invRes.rows.length) return [];

  // For each (book, location) compute period movements from inventory_history
  const bookLocPairs = invRes.rows.map((r: Record<string, unknown>) =>
    `(${r.book_id as number}, ${r.location_id as number})`
  ).join(', ');

  // Stock In / Stock Out / Returned for the period
  const histParams = [...params];
  if (filters.dateFrom) histParams.push(filters.dateFrom);
  if (filters.dateTo)   histParams.push(filters.dateTo);

  const histRes = await db.query(
    `SELECT
       ih.book_id,
       ih.location_id,
       COALESCE(SUM(CASE WHEN ih.delta > 0 THEN ih.delta ELSE 0 END), 0)::int                          AS stock_in,
       COALESCE(SUM(CASE WHEN ih.delta < 0 THEN ABS(ih.delta) ELSE 0 END), 0)::int                     AS stock_out,
       COALESCE(SUM(CASE WHEN ih.reference_type = 'pos_return' THEN ih.delta ELSE 0 END), 0)::int       AS returned
     FROM inventory_history ih
     JOIN locations lh ON lh.id = ih.location_id
     WHERE (ih.book_id, ih.location_id) IN (${bookLocPairs})
       ${histConditions.map(c => `AND ${c}`).join(' ')}
     GROUP BY ih.book_id, ih.location_id`,
    histParams,
  );

  // Build history map
  const histMap = new Map<string, { stockIn: number; stockOut: number; returned: number }>();
  for (const row of histRes.rows as Record<string, unknown>[]) {
    histMap.set(`${row.book_id}-${row.location_id}`, {
      stockIn:  Number(row.stock_in),
      stockOut: Number(row.stock_out),
      returned: Number(row.returned),
    });
  }

  // Opening stock = closing_stock - net_movement (stock_in - stock_out) during period
  // If no period filter, opening stock equals closing stock (no movement slice)
  const hasPeriod = !!(filters.dateFrom || filters.dateTo);

  // Active reservations per (book, location)
  let reservedMap = new Map<string, number>();
  if (hasReservations) {
    const resRes = await db.query(
      `SELECT book_id, location_id, COALESCE(SUM(quantity), 0)::int AS reserved
       FROM inventory_reservations
       WHERE status = 'reserved'
         AND (book_id, location_id) IN (${bookLocPairs})
       GROUP BY book_id, location_id`,
    );
    for (const row of resRes.rows as Record<string, unknown>[]) {
      reservedMap.set(`${row.book_id}-${row.location_id}`, Number(row.reserved));
    }
  }

  return invRes.rows.map((row: Record<string, unknown>) => {
    const key = `${row.book_id}-${row.location_id}`;
    const hist = histMap.get(key) ?? { stockIn: 0, stockOut: 0, returned: 0 };
    const closingStock = Number(row.closing_stock);
    const netMovement = hist.stockIn - hist.stockOut;
    const openingStock = hasPeriod ? Math.max(0, closingStock - netMovement) : closingStock;

    return {
      bookId:        row.book_id as number,
      bookTitle:     row.book_title as string,
      bookIsbn:      row.book_isbn as string,
      locationId:    row.location_id as number,
      locationName:  row.location_name as string,
      branchId:      row.branch_id as number,
      openingStock,
      stockIn:       hist.stockIn,
      stockOut:      hist.stockOut,
      reserved:      reservedMap.get(key) ?? 0,
      returned:      hist.returned,
      damaged:       Number(row.damaged),
      closingStock,
    };
  });
}

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

// ── KPI Report ────────────────────────────────────────────────────────────────

export async function getKpis(branchId?: number): Promise<KpiReport> {
  const params = branchId ? [branchId] : [];
  const branchCond = branchId ? 'AND branch_id = $1' : '';
  const branchCondT = branchId ? 'AND t.branch_id = $1' : '';
  const branchCondO = branchId ? 'AND o.branch_id = $1' : '';
  const branchCondE = branchId ? 'AND e.branch_id = $1' : '';

  const ACTIVE_ORDER_STATUSES = `('Pending','Confirmed','In_Progress','DRAFT','CONFIRMED','PAID')`;
  const CANCELLED_STATUSES    = `('Cancelled','CANCELLED')`;

  const [
    // 1. Sales
    dailyOrdersSalesRes,
    dailyPosSalesRes,
    dailyExchangesSalesRes,
    monthlyOrdersSalesRes,
    monthlyPosSalesRes,
    monthlyExchangesSalesRes,

    // 2. Revenue
    dailyPosRevenueRes,
    dailyOrdersRevenueRes,
    dailyExchangesRevenueRes,
    monthlyPosRevenueRes,
    monthlyOrdersRevenueRes,
    monthlyExchangesRevenueRes,

    // 3. Outstanding Balance
    outstandingRes,

    // 4. Other existing metrics
    aovRes,
    custRes,
    lowStockRes,
    pendingRes,
    excRes,
  ] = await Promise.all([
    // Daily Orders Sales
    db.query(
      `SELECT COALESCE(SUM(total), 0)::NUMERIC AS val
       FROM orders
       WHERE DATE(created_at) = CURRENT_DATE
         AND status NOT IN ${CANCELLED_STATUSES}
         ${branchCond}`,
      params,
    ),
    // Daily POS Sales
    db.query(
      `SELECT COALESCE(SUM(grand_total), 0)::NUMERIC AS val
       FROM transactions
       WHERE DATE(created_at) = CURRENT_DATE
         AND status = 'completed'
         ${branchCond}`,
      params,
    ),
    // Daily Exchanges Sales
    db.query(
      `SELECT COALESCE(SUM(total_outgoing_value), 0)::NUMERIC AS val
       FROM exchanges
       WHERE DATE(created_at) = CURRENT_DATE
         AND status IN ('Completed', 'COMPLETED')
         ${branchCond}`,
      params,
    ),
    // Monthly Orders Sales
    db.query(
      `SELECT COALESCE(SUM(total), 0)::NUMERIC AS val
       FROM orders
       WHERE date_trunc('month', created_at) = date_trunc('month', now())
         AND status NOT IN ${CANCELLED_STATUSES}
         ${branchCond}`,
      params,
    ),
    // Monthly POS Sales
    db.query(
      `SELECT COALESCE(SUM(grand_total), 0)::NUMERIC AS val
       FROM transactions
       WHERE date_trunc('month', created_at) = date_trunc('month', now())
         AND status = 'completed'
         ${branchCond}`,
      params,
    ),
    // Monthly Exchanges Sales
    db.query(
      `SELECT COALESCE(SUM(total_outgoing_value), 0)::NUMERIC AS val
       FROM exchanges
       WHERE date_trunc('month', created_at) = date_trunc('month', now())
         AND status IN ('Completed', 'COMPLETED')
         ${branchCond}`,
      params,
    ),

    // Daily POS Revenue
    db.query(
      `SELECT COALESCE(SUM(tp.amount), 0)::NUMERIC AS val
       FROM transaction_payments tp
       JOIN transactions t ON t.id = tp.transaction_id
       WHERE t.status = 'completed'
         AND DATE(tp.created_at) = CURRENT_DATE
         ${branchCondT}`,
      params,
    ),
    // Daily Orders Revenue
    db.query(
      `SELECT COALESCE(SUM(op.amount), 0)::NUMERIC AS val
       FROM order_payments op
       JOIN orders o ON o.id = op.order_id
       WHERE op.status IN ('success', 'partially_refunded')
         AND o.status NOT IN ${CANCELLED_STATUSES}
         AND DATE(op.processed_at) = CURRENT_DATE
         ${branchCondO}`,
      params,
    ),
    // Daily Exchanges Revenue
    db.query(
      `SELECT COALESCE(SUM(CASE WHEN ese.entry_type = 'cash_payment' THEN ese.amount WHEN ese.entry_type = 'cash_refund' THEN -ese.amount ELSE 0 END), 0)::NUMERIC AS val
       FROM exchange_settlement_entries ese
       JOIN exchanges e ON e.id = ese.exchange_id
       WHERE e.status IN ('Completed', 'COMPLETED')
         AND DATE(ese.created_at) = CURRENT_DATE
         ${branchCondE}`,
      params,
    ),
    // Monthly POS Revenue
    db.query(
      `SELECT COALESCE(SUM(tp.amount), 0)::NUMERIC AS val
       FROM transaction_payments tp
       JOIN transactions t ON t.id = tp.transaction_id
       WHERE t.status = 'completed'
         AND date_trunc('month', tp.created_at) = date_trunc('month', now())
         ${branchCondT}`,
      params,
    ),
    // Monthly Orders Revenue
    db.query(
      `SELECT COALESCE(SUM(op.amount), 0)::NUMERIC AS val
       FROM order_payments op
       JOIN orders o ON o.id = op.order_id
       WHERE op.status IN ('success', 'partially_refunded')
         AND o.status NOT IN ${CANCELLED_STATUSES}
         AND date_trunc('month', op.processed_at) = date_trunc('month', now())
         ${branchCondO}`,
      params,
    ),
    // Monthly Exchanges Revenue
    db.query(
      `SELECT COALESCE(SUM(CASE WHEN ese.entry_type = 'cash_payment' THEN ese.amount WHEN ese.entry_type = 'cash_refund' THEN -ese.amount ELSE 0 END), 0)::NUMERIC AS val
       FROM exchange_settlement_entries ese
       JOIN exchanges e ON e.id = ese.exchange_id
       WHERE e.status IN ('Completed', 'COMPLETED')
         AND date_trunc('month', ese.created_at) = date_trunc('month', now())
         ${branchCondE}`,
      params,
    ),

    // Outstanding Balance
    db.query(
      `SELECT COALESCE(SUM(outstanding_amount), 0)::NUMERIC AS val
       FROM receivables
       WHERE status IN ('Pending', 'PartiallyPaid', 'Overdue')
         ${branchCond}`,
      params,
    ),

    // Average order value
    db.query(
      `SELECT COALESCE(AVG(total), 0)::NUMERIC AS val
       FROM orders
       WHERE status NOT IN ${CANCELLED_STATUSES}
         ${branchCond}`,
      params,
    ),
    // Active customers
    db.query(
      `SELECT COUNT(*)::INTEGER AS val
       FROM customers
       WHERE is_active = true
         ${branchId ? `AND branch_id = $1` : ''}`,
      params,
    ),
    // Low stock alerts
    db.query(
      `SELECT COUNT(*)::INTEGER AS val
       FROM inventory i
       JOIN locations l ON l.id = i.location_id
       WHERE i.quantity <= i.reorder_point
         ${branchId ? `AND l.branch_id = $1` : ''}`,
      params,
    ),
    // Pending orders
    db.query(
      `SELECT COUNT(*)::INTEGER AS val
       FROM orders
       WHERE status IN ${ACTIVE_ORDER_STATUSES}
         ${branchCond}`,
      params,
    ),
    // Exchanges today
    db.query(
      `SELECT COUNT(*)::INTEGER AS val
       FROM exchanges
       WHERE DATE(created_at) = CURRENT_DATE
         ${branchCond}`,
      params,
    ),
  ]);

  const dailySales =
    parseFloat(dailyOrdersSalesRes.rows[0].val) +
    parseFloat(dailyPosSalesRes.rows[0].val) +
    parseFloat(dailyExchangesSalesRes.rows[0].val);

  const monthlySales =
    parseFloat(monthlyOrdersSalesRes.rows[0].val) +
    parseFloat(monthlyPosSalesRes.rows[0].val) +
    parseFloat(monthlyExchangesSalesRes.rows[0].val);

  const dailyRevenue =
    parseFloat(dailyPosRevenueRes.rows[0].val) +
    parseFloat(dailyOrdersRevenueRes.rows[0].val) +
    parseFloat(dailyExchangesRevenueRes.rows[0].val);

  const monthlyRevenue =
    parseFloat(monthlyPosRevenueRes.rows[0].val) +
    parseFloat(monthlyOrdersRevenueRes.rows[0].val) +
    parseFloat(monthlyExchangesRevenueRes.rows[0].val);

  const outstandingBalance = parseFloat(outstandingRes.rows[0].val);

  // Run computeNetProfit for both daily and monthly scopes in parallel,
  // alongside the procurement expense query — all three are independent.
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    .toISOString().slice(0, 10);

  const [profitResult, dailyProfitResult, procurementExpenseRes] = await Promise.all([
    computeNetProfit({ branchId }),                                            // monthly (no date scope = all-time → use month)
    computeNetProfit({ branchId, dateFrom: today, dateTo: today }),            // today
    db.query(
      `SELECT COALESCE(SUM(total_amount), 0)::NUMERIC AS val
       FROM purchase_orders
       WHERE status IN ('received','closed')
         AND date_trunc('month', updated_at) = date_trunc('month', now())
         ${branchCond}`,
      params,
    ),
  ]);
  // Re-run for month-scoped profit (separate from all-time)
  const monthlyProfitResult = await computeNetProfit({ branchId, dateFrom: monthStart, dateTo: today });

  const procurementExpense = parseFloat(procurementExpenseRes.rows[0].val as string);

  // Gross profit = monthly fulfilled revenue − purchase cost (before returns/exchanges)
  // Note: revenue is already post-discount, so no discount subtraction needed here.
  const grossProfit = monthlyProfitResult.fulfilledRevenue - monthlyProfitResult.purchaseCost;

  return {
    dailySales,
    monthlySales,
    dailyRevenue,
    monthlyRevenue,
    averageOrderValue:    parseFloat(aovRes.rows[0].val),
    totalActiveCustomers: custRes.rows[0].val,
    lowStockAlerts:       lowStockRes.rows[0].val,
    pendingOrders:        pendingRes.rows[0].val,
    totalExchangesToday:  excRes.rows[0].val,
    outstandingBalance,
    // Net profit breakdown from computeNetProfit (fulfilled-only, cost-aware)
    netProfit:              monthlyProfitResult.netProfit,
    fulfilledRevenue:       monthlyProfitResult.fulfilledRevenue,
    outstandingReceivables: monthlyProfitResult.outstandingReceivables,
    cashSalesRevenue:       monthlyProfitResult.cashSalesRevenue,
    creditSalesRevenue:     monthlyProfitResult.creditSalesRevenue,
    collectedCreditRevenue: monthlyProfitResult.collectedCreditRevenue,
    purchaseCost:           monthlyProfitResult.purchaseCost,
    totalDiscounts:         monthlyProfitResult.totalDiscounts,
    // Executive financial KPIs
    procurementExpense,
    grossProfit,
    dailyNetProfit:   dailyProfitResult.netProfit,
    monthlyNetProfit: monthlyProfitResult.netProfit,
  };
}

// ── Sales Export Rows ─────────────────────────────────────────────────────────

export interface SalesExportRow {
  order_reference: string;
  date: string;
  customer_name: string;
  sale_type: string;
  fulfillment_status: string;
  subtotal: number;
  discount_normal: number;
  discount_merchant: number;
  discount_special: number;
  total_discount: number;
  purchase_cost: number;
  net_profit: number;
  payment_status: string;
  collected_amount: number;
  outstanding_amount: number;
}

export async function getSalesExportRows(filters: ReportFilters): Promise<SalesExportRow[]> {
  const params: unknown[] = [];
  const conditions: string[] = [`o.status NOT IN ('Cancelled','CANCELLED')`];

  if (filters.branchId) { params.push(filters.branchId); conditions.push(`o.branch_id = $${params.length}`); }
  if (filters.dateFrom) { params.push(filters.dateFrom); conditions.push(`o.created_at::date >= $${params.length}::date`); }
  if (filters.dateTo)   { params.push(filters.dateTo);   conditions.push(`o.created_at::date <= $${params.length}::date`); }

  const where = 'WHERE ' + conditions.join(' AND ');

  // Discount breakdown per order (by type)
  const discountRes = await db.query(
    `SELECT
       oli.order_id,
       COALESCE(SUM(CASE WHEN oli.discount_type='Normal'   THEN oli.discount_amount ELSE 0 END),0)::NUMERIC AS disc_normal,
       COALESCE(SUM(CASE WHEN oli.discount_type='Merchant' THEN oli.discount_amount ELSE 0 END),0)::NUMERIC AS disc_merchant,
       COALESCE(SUM(CASE WHEN oli.discount_type='Special'  THEN oli.discount_amount ELSE 0 END),0)::NUMERIC AS disc_special
     FROM order_line_items oli
     GROUP BY oli.order_id`,
  );
  const discMap = new Map<string, { normal: number; merchant: number; special: number }>();
  for (const row of discountRes.rows as Record<string, unknown>[]) {
    discMap.set(String(row.order_id), {
      normal:   parseFloat(row.disc_normal   as string),
      merchant: parseFloat(row.disc_merchant as string),
      special:  parseFloat(row.disc_special  as string),
    });
  }

  // Purchase cost per order (most-recent PO unit cost × qty per line)
  const costRes = await db.query(
    `SELECT
       oli.order_id,
       COALESCE(SUM(COALESCE(lc.unit_cost,0) * oli.quantity),0)::NUMERIC AS purchase_cost
     FROM order_line_items oli
     LEFT JOIN LATERAL (
       SELECT pli.unit_cost FROM po_line_items pli
       WHERE pli.book_id = oli.book_id ORDER BY pli.id DESC LIMIT 1
     ) lc ON true
     GROUP BY oli.order_id`,
  );
  const costMap = new Map<string, number>();
  for (const row of costRes.rows as Record<string, unknown>[]) {
    costMap.set(String(row.order_id), parseFloat(row.purchase_cost as string));
  }

  const res = await db.query(
    `SELECT
       o.id, o.order_number, o.created_at, o.status, o.sale_type,
       o.subtotal, o.discount_total, o.total, o.payment_status,
       COALESCE(c.full_name, 'Walk-in') AS customer_name,
       COALESCE(r.original_amount, 0)::NUMERIC             AS original_amount,
       COALESCE(r.outstanding_amount, 0)::NUMERIC          AS outstanding_amount
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN receivables r ON r.source_type = 'order_credit_sale' AND r.source_entity_id = o.id
     ${where}
     ORDER BY o.created_at DESC`,
    params,
  );

  return (res.rows as Record<string, unknown>[]).map(row => {
    const orderId = String(row.id);
    const disc = discMap.get(orderId) ?? { normal: 0, merchant: 0, special: 0 };
    const totalDiscount = parseFloat(row.discount_total as string);
    const purchaseCost = costMap.get(orderId) ?? 0;
    const total = parseFloat(row.total as string);
    const originalAmount = parseFloat(row.original_amount as string);
    const outstandingAmount = parseFloat(row.outstanding_amount as string);
    const collectedAmount = originalAmount > 0 ? originalAmount - outstandingAmount : total;

    return {
      order_reference:    row.order_number as string,
      date:               (row.created_at as Date).toISOString().slice(0, 10),
      customer_name:      row.customer_name as string,
      sale_type:          row.sale_type as string,
      fulfillment_status: row.status as string,
      subtotal:           parseFloat(row.subtotal as string),
      discount_normal:    disc.normal,
      discount_merchant:  disc.merchant,
      discount_special:   disc.special,
      total_discount:     totalDiscount,
      purchase_cost:      purchaseCost,
      net_profit:         total - purchaseCost - totalDiscount,
      payment_status:     row.payment_status as string,
      collected_amount:   collectedAmount,
      outstanding_amount: outstandingAmount,
    };
  });
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
       po.created_at,
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
    date:              (row.created_at as Date).toISOString().slice(0, 10),
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
  const params: unknown[] = ['order_credit_sale'];
  const conditions: string[] = [`r.source_type = $1`];
  if (filters.branchId) { params.push(filters.branchId); conditions.push(`r.branch_id = $${params.length}`); }
  if (filters.dateFrom) { params.push(filters.dateFrom); conditions.push(`r.created_at::date >= $${params.length}::date`); }
  if (filters.dateTo)   { params.push(filters.dateTo);   conditions.push(`r.created_at::date <= $${params.length}::date`); }
  const where = 'WHERE ' + conditions.join(' AND ');

  const res = await db.query(
    `SELECT
       r.created_at,
       r.original_amount,
       r.outstanding_amount,
       r.due_date,
       r.status,
       GREATEST(0, EXTRACT(DAY FROM now() - r.due_date)::int) AS days_overdue,
       COALESCE(o.order_number, 'N/A') AS order_reference,
       COALESCE(c.full_name, 'Unknown') AS customer_name,
       COALESCE(o.payment_status, r.status) AS payment_status
     FROM receivables r
     LEFT JOIN orders o ON o.id = r.source_entity_id
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
      date:               (row.created_at as Date).toISOString().slice(0, 10),
      customer_name:      row.customer_name as string,
      original_amount:    original,
      collected_amount:   original - outstanding,
      outstanding_amount: outstanding,
      due_date:           row.due_date ? (row.due_date as Date).toISOString().slice(0, 10) : '',
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
}

export async function getInventoryExportRowsV2(filters: ReportFilters): Promise<InventoryExportRowV2[]> {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filters.branchId) { params.push(filters.branchId); conditions.push(`l.branch_id = $${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  // Check whether inventory_reservations table exists — it may be absent on older DB schemas
  let hasReservationsTable = false;
  try {
    const tblCheck = await db.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'inventory_reservations' LIMIT 1`,
    );
    hasReservationsTable = tblCheck.rows.length > 0;
  } catch { /* non-fatal — treat as absent */ }

  // Build the reservation sub-query conditionally
  const reservationJoin = hasReservationsTable
    ? `LEFT JOIN (
         SELECT book_id, location_id, SUM(quantity)::int AS reserved
         FROM inventory_reservations WHERE status = 'reserved'
         GROUP BY book_id, location_id
       ) res ON res.book_id = i.book_id AND res.location_id = i.location_id`
    : '';

  // When the table is absent, use 0 for reserved and i.quantity for available
  const reservedExpr  = hasReservationsTable ? `COALESCE(res.reserved, 0)::int`                           : `0::int`;
  const availableExpr = hasReservationsTable ? `GREATEST(0, i.quantity - COALESCE(res.reserved, 0))::int` : `i.quantity::int`;
  // GROUP BY clause differs — res.reserved is only selectable when the join exists
  const groupByReserved = hasReservationsTable ? `, res.reserved` : '';

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
       COALESCE(lc.unit_cost, 0)::NUMERIC                                 AS unit_cost,
       (SELECT MAX(ih.created_at)
        FROM inventory_history ih
        WHERE ih.book_id = i.book_id AND ih.location_id = i.location_id)  AS last_movement_date
     FROM inventory i
     JOIN books b ON b.id = i.book_id
     JOIN locations l ON l.id = i.location_id
     LEFT JOIN book_authors ba ON ba.book_id = b.id
     LEFT JOIN authors a ON a.id = ba.author_id
     ${reservationJoin}
     LEFT JOIN LATERAL (
       SELECT pli.unit_cost FROM po_line_items pli
       WHERE pli.book_id = b.id ORDER BY pli.id DESC LIMIT 1
     ) lc ON true
     ${where}
     GROUP BY i.book_id, b.sku, b.isbn, b.title, b.publisher, i.location_id,
              i.quantity${groupByReserved}, lc.unit_cost
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
    last_movement_date: row.last_movement_date
      ? (row.last_movement_date as Date).toISOString().slice(0, 10)
      : '',
  }));
}
