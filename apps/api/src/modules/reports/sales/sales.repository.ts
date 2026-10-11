import type { Queryable } from '../../../db/tx.js';
import { reportRows } from '../../../db/reportDb.js';
import { NOT_SALE_ORDER_STATUS_LIST } from './sales.policy.js';
import type { OrderTotalsRow, ReportFilters, ReportScope } from './sales.types.js';

// Order and POS totals of the Sales Report. Report SQL runs on the report
// connection (db/reportDb.ts); values always go in as parameters.

/** `alias.branch_id = $n` and the date range on `alias.column`, both ends included. */
export function scopeConditions(scope: ReportScope, alias: string, column = 'created_at'): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (scope.branchId) {
    params.push(scope.branchId);
    conditions.push(`${alias}.branch_id = $${params.length}`);
  }
  if (scope.dateFrom) {
    params.push(scope.dateFrom);
    conditions.push(`${alias}.${column}::date >= $${params.length}::date`);
  }
  if (scope.dateTo) {
    params.push(scope.dateTo);
    conditions.push(`${alias}.${column}::date <= $${params.length}::date`);
  }
  return { conditions, params };
}

/** Orders that are sales: confirmed or later. */
function orderWhere(scope: ReportScope): { where: string; params: unknown[] } {
  const { conditions, params } = scopeConditions(scope, 'o');
  return { where: `WHERE ${[`o.status NOT IN ${NOT_SALE_ORDER_STATUS_LIST}`, ...conditions].join(' AND ')}`, params };
}

export async function orderTotals(q: Queryable, scope: ReportScope): Promise<OrderTotalsRow> {
  const { where, params } = orderWhere(scope);
  const [row] = await reportRows<OrderTotalsRow>(
    q,
    `SELECT COALESCE(SUM(o.total), 0)::NUMERIC AS total_sales,
            COUNT(*)::INTEGER AS total_orders,
            COALESCE(AVG(o.total), 0)::NUMERIC AS avg_order_value
     FROM orders o ${where}`,
    params,
  );
  return row;
}

/** Order totals per day, week or month (the bucket name is from a fixed list, never request text). */
export async function orderTotalsByPeriod(q: Queryable, filters: ReportFilters): Promise<Array<OrderTotalsRow & { period: string }>> {
  const { where, params } = orderWhere(filters);
  const bucket = `date_trunc('${filters.groupBy}', o.created_at)`;
  return reportRows(
    q,
    `SELECT ${bucket}::TEXT AS period,
            COALESCE(SUM(o.total), 0)::NUMERIC AS total_sales,
            COUNT(*)::INTEGER AS total_orders,
            COALESCE(AVG(o.total), 0)::NUMERIC AS avg_order_value
     FROM orders o ${where}
     GROUP BY ${bucket}
     ORDER BY ${bucket}`,
    params,
  );
}

export async function orderTotalsByBranch(
  q: Queryable,
  scope: ReportScope,
): Promise<Array<{ branch_id: number; branch_name: string; total_sales: string; total_orders: number }>> {
  const { where, params } = orderWhere(scope);
  return reportRows(
    q,
    `SELECT o.branch_id, b.name AS branch_name,
            COALESCE(SUM(o.total), 0)::NUMERIC AS total_sales,
            COUNT(*)::INTEGER AS total_orders
     FROM orders o
     JOIN branches b ON b.id = o.branch_id
     ${where}
     GROUP BY o.branch_id, b.name
     ORDER BY total_sales DESC`,
    params,
  );
}

export async function posTotals(q: Queryable, scope: ReportScope): Promise<{ total_pos_sales: string; total_pos_transactions: number }> {
  const { conditions, params } = scopeConditions(scope, 't');
  const [row] = await reportRows<{ total_pos_sales: string; total_pos_transactions: number }>(
    q,
    `SELECT COALESCE(SUM(t.grand_total), 0)::NUMERIC AS total_pos_sales,
            COUNT(*)::INTEGER AS total_pos_transactions
     FROM transactions t
     WHERE ${[`t.status = 'completed'`, ...conditions].join(' AND ')}`,
    params,
  );
  return row;
}
