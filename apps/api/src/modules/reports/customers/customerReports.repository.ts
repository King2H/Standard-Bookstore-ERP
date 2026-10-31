import type { Queryable } from '../../../db/tx.js';
import { reportRows } from '../../../db/reportDb.js';
import { NOT_SALE_ORDER_STATUS_LIST } from '../sales/sales.policy.js';
import { scopeConditions, where, type ReportFilters, type ReportScope } from '../reportScope.js';

// Customer reports (#22). A customer's sales are their orders confirmed or
// later (drafts and cancelled orders are not sales, owner decision 3a).

const IS_SALE = `o.status NOT IN ${NOT_SALE_ORDER_STATUS_LIST}`;

/**
 * Sales in a range (#175): each order on its confirmation day, and as a minus
 * on its cancellation day, so a reported day never changes.
 */
const ORDER_SALES = 'order_sale_events ev JOIN orders o ON o.id = ev.order_id';

export async function customerTotals(q: Queryable, branchId: number | undefined): Promise<{ total_customers: number; active_customers: number }> {
  const params = branchId ? [branchId] : [];
  const [row] = await reportRows<{ total_customers: number; active_customers: number }>(
    q,
    `SELECT COUNT(*)::INTEGER AS total_customers,
            COUNT(CASE WHEN c.is_active THEN 1 END)::INTEGER AS active_customers
     FROM customers c ${where(branchId ? ['c.branch_id = $1'] : [])}`,
    params,
  );
  return row;
}

/** Customers with a sale in the range who have made more than one sale in all. */
export async function repeatCustomers(q: Queryable, scope: ReportScope): Promise<number> {
  const { conditions, params } = scopeConditions({ dateFrom: scope.dateFrom, dateTo: scope.dateTo }, 'ev', { column: 'sale_at' });
  if (scope.branchId) {
    params.push(scope.branchId);
    conditions.push(`c.branch_id = $${params.length}`);
  }
  // A sale in the range nets its cancellations there; "more than one in all" is the customer as of now.
  const [row] = await reportRows<{ repeat_customers: number }>(
    q,
    `SELECT COUNT(*)::INTEGER AS repeat_customers FROM (
       SELECT o.customer_id
       FROM ${ORDER_SALES}
       JOIN customers c ON c.id = o.customer_id
       ${where(conditions)}
       GROUP BY o.customer_id
       HAVING SUM(ev.sign) > 0
     ) sold
     WHERE sold.customer_id IN (
       SELECT o.customer_id FROM orders o
       WHERE o.customer_id IS NOT NULL AND ${IS_SALE}
       GROUP BY o.customer_id HAVING COUNT(*) > 1
     )`,
    params,
  );
  return row.repeat_customers;
}

/** Customers registered in the range, in total and per day, week or month. */
export async function newCustomers(q: Queryable, filters: ReportFilters): Promise<{ total: number; byPeriod: Array<{ period: string; new_customers: number }> }> {
  const { conditions, params } = scopeConditions(filters, 'c');
  const bucket = `date_trunc('${filters.groupBy}', c.created_at)`;
  const [[total], byPeriod] = await Promise.all([
    reportRows<{ new_customers: number }>(q, `SELECT COUNT(*)::INTEGER AS new_customers FROM customers c ${where(conditions)}`, params),
    reportRows<{ period: string; new_customers: number }>(
      q,
      `SELECT ${bucket}::TEXT AS period, COUNT(*)::INTEGER AS new_customers
       FROM customers c ${where(conditions)}
       GROUP BY ${bucket}
       ORDER BY ${bucket}`,
      params,
    ),
  ]);
  return { total: total.new_customers, byPeriod };
}

/** The 20 customers who spent most on sales in the range. */
export async function topCustomers(
  q: Queryable,
  scope: ReportScope,
): Promise<Array<{ customer_id: number; full_name: string; total_spend: string; order_count: number }>> {
  const { conditions, params } = scopeConditions({ dateFrom: scope.dateFrom, dateTo: scope.dateTo }, 'ev', { column: 'sale_at' });
  if (scope.branchId) {
    params.push(scope.branchId);
    conditions.push(`c.branch_id = $${params.length}`);
  }
  return reportRows(
    q,
    `SELECT c.id AS customer_id, c.full_name,
            COALESCE(SUM(ev.sign * o.total), 0)::NUMERIC AS total_spend,
            COALESCE(SUM(ev.sign), 0)::INTEGER AS order_count
     FROM ${ORDER_SALES}
     JOIN customers c ON c.id = o.customer_id
     ${where(conditions)}
     GROUP BY c.id, c.full_name
     HAVING SUM(ev.sign * o.total) <> 0 OR SUM(ev.sign) <> 0
     ORDER BY total_spend DESC
     LIMIT 20`,
    params,
  );
}
