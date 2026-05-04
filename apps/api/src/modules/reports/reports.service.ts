import { db } from '../../db/index.js';

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
  dailyRevenue: number;
  monthlyRevenue: number;
  averageOrderValue: number;
  totalActiveCustomers: number;
  lowStockAlerts: number;
  pendingOrders: number;
  totalExchangesToday: number;
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

  return {
    summary: {
      totalSales:           parseFloat(s.total_sales),
      totalOrders:          s.total_orders,
      averageOrderValue:    parseFloat(s.avg_order_value),
      totalPosSales:        parseFloat(p.total_pos_sales),
      totalPosTransactions: p.total_pos_transactions,
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
    byMethod: byMethodRes.rows.map(r => ({
      method: r.method,
      total:  parseFloat(r.total),
      count:  r.count,
    })),
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
       COUNT(DISTINCT i.book_id)::INTEGER                                                AS total_books,
       COALESCE(SUM(i.quantity), 0)::INTEGER                                             AS total_units,
       COUNT(CASE WHEN i.quantity <= i.reorder_point AND i.quantity > 0 THEN 1 END)::INTEGER AS low_stock,
       COUNT(CASE WHEN i.quantity = 0 THEN 1 END)::INTEGER                               AS out_of_stock
     FROM inventory i
     JOIN locations l ON l.id = i.location_id
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
  // Build parameterized branch condition — never interpolate user input into SQL
  const branchParams: unknown[] = [];
  const branchCond = branchId
    ? (() => { branchParams.push(branchId); return `AND branch_id = $${branchParams.length}`; })()
    : '';

  // Order status values: support both legacy ('Pending','Confirmed','In_Progress')
  // and new lifecycle values ('DRAFT','CONFIRMED','PAID') introduced in migration 33.
  const ACTIVE_ORDER_STATUSES = `('Pending','Confirmed','In_Progress','DRAFT','CONFIRMED','PAID')`;
  const CANCELLED_STATUSES    = `('Cancelled','CANCELLED')`;

  const [dailyRes, monthlyRes, aovRes, custRes, lowStockRes, pendingRes, excRes, posRes] = await Promise.all([
    // Daily revenue — orders (non-cancelled) created today
    db.query(
      `SELECT COALESCE(SUM(total), 0)::NUMERIC AS val
       FROM orders
       WHERE DATE(created_at) = CURRENT_DATE
         AND status NOT IN ${CANCELLED_STATUSES}
         ${branchCond}`,
      branchParams,
    ),
    // Monthly revenue — orders this calendar month
    db.query(
      `SELECT COALESCE(SUM(total), 0)::NUMERIC AS val
       FROM orders
       WHERE date_trunc('month', created_at) = date_trunc('month', now())
         AND status NOT IN ${CANCELLED_STATUSES}
         ${branchCond}`,
      branchParams,
    ),
    // Average order value — all completed/paid orders
    db.query(
      `SELECT COALESCE(AVG(total), 0)::NUMERIC AS val
       FROM orders
       WHERE status NOT IN ${CANCELLED_STATUSES}
         ${branchCond}`,
      branchParams,
    ),
    // Active customers
    db.query(
      `SELECT COUNT(*)::INTEGER AS val
       FROM customers
       WHERE is_active = true
         ${branchId ? `AND branch_id = $1` : ''}`,
      branchId ? [branchId] : [],
    ),
    // Low stock alerts — items at or below reorder point
    db.query(
      `SELECT COUNT(*)::INTEGER AS val
       FROM inventory i
       JOIN locations l ON l.id = i.location_id
       WHERE i.quantity <= i.reorder_point
         ${branchId ? `AND l.branch_id = $1` : ''}`,
      branchId ? [branchId] : [],
    ),
    // Pending / in-progress orders (need action)
    db.query(
      `SELECT COUNT(*)::INTEGER AS val
       FROM orders
       WHERE status IN ${ACTIVE_ORDER_STATUSES}
         ${branchCond}`,
      branchParams,
    ),
    // Exchanges today
    db.query(
      `SELECT COUNT(*)::INTEGER AS val
       FROM exchanges
       WHERE DATE(created_at) = CURRENT_DATE
         ${branchCond}`,
      branchParams,
    ),
    // POS revenue today (completed transactions)
    db.query(
      `SELECT COALESCE(SUM(grand_total), 0)::NUMERIC AS val
       FROM transactions
       WHERE DATE(created_at) = CURRENT_DATE
         AND status = 'completed'
         ${branchId ? `AND branch_id = $1` : ''}`,
      branchId ? [branchId] : [],
    ),
  ]);

  const orderDailyRevenue = parseFloat(dailyRes.rows[0].val);
  const posDailyRevenue   = parseFloat(posRes.rows[0].val);

  return {
    dailyRevenue:         orderDailyRevenue + posDailyRevenue,
    monthlyRevenue:       parseFloat(monthlyRes.rows[0].val),
    averageOrderValue:    parseFloat(aovRes.rows[0].val),
    totalActiveCustomers: custRes.rows[0].val,
    lowStockAlerts:       lowStockRes.rows[0].val,
    pendingOrders:        pendingRes.rows[0].val,
    totalExchangesToday:  excRes.rows[0].val,
  };
}
