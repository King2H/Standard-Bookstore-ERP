import type { Queryable } from '../../../db/tx.js';
import { reportRows } from '../../../db/reportDb.js';
import { scopeConditions } from '../reportScope.js';
import type { OrderTotalsRow, ReportFilters, ReportScope } from './sales.types.js';

// Order and POS totals of the Sales Report. Report SQL runs on the report
// connection (db/reportDb.ts); values always go in as parameters.

/**
 * Orders as sales (#175): each counts on its confirmation day, and once more
 * as a minus on its cancellation day (order_sale_events, `ev.sign`), so a
 * day already reported never changes.
 */
function orderWhere(scope: ReportScope): { where: string; params: unknown[] } {
  const { conditions, params } = scopeConditions(scope, 'ev', { column: 'sale_at', branchAlias: 'o' });
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}
const ORDER_SALES = 'order_sale_events ev JOIN orders o ON o.id = ev.order_id';
const ORDER_AMOUNTS = `COALESCE(SUM(ev.sign * o.total), 0)::NUMERIC AS total_sales,
            COALESCE(SUM(ev.sign), 0)::INTEGER AS total_orders`;

export async function orderTotals(q: Queryable, scope: ReportScope): Promise<OrderTotalsRow> {
  const { where, params } = orderWhere(scope);
  const [row] = await reportRows<OrderTotalsRow>(
    q,
    `SELECT ${ORDER_AMOUNTS},
            COALESCE(SUM(ev.sign * o.total) / NULLIF(SUM(ev.sign), 0), 0)::NUMERIC AS avg_order_value
     FROM ${ORDER_SALES} ${where}`,
    params,
  );
  return row;
}

/** Order totals per day, week or month (the bucket name is from a fixed list, never request text). */
export async function orderTotalsByPeriod(q: Queryable, filters: ReportFilters): Promise<Array<OrderTotalsRow & { period: string }>> {
  const { where, params } = orderWhere(filters);
  const bucket = `date_trunc('${filters.groupBy}', ev.sale_at)`;
  return reportRows(
    q,
    `SELECT ${bucket}::TEXT AS period,
            ${ORDER_AMOUNTS},
            COALESCE(SUM(ev.sign * o.total) / NULLIF(SUM(ev.sign), 0), 0)::NUMERIC AS avg_order_value
     FROM ${ORDER_SALES} ${where}
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
            ${ORDER_AMOUNTS}
     FROM ${ORDER_SALES}
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
