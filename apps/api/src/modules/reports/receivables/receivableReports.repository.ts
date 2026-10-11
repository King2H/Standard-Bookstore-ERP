import type { Queryable } from '../../../db/tx.js';
import { reportRows } from '../../../db/reportDb.js';
import { scopeConditions, where, type ReportScope } from '../reportScope.js';

// Receivables reports (#22): open balances by age, and every receivable
// raised in a range.

export interface AgingRow {
  customer_name: string;
  invoice_no: string;
  invoice_date: string;
  due_date_str: string | null;
  outstanding_amount: string;
  days_overdue: number;
  last_payment_date_str: string | null;
}

/** Open receivables now, most overdue first. */
export async function openReceivables(q: Queryable, branchId: number | undefined): Promise<AgingRow[]> {
  const params = branchId ? [branchId] : [];
  return reportRows<AgingRow>(
    q,
    `SELECT
       COALESCE(c.full_name, 'Unknown') AS customer_name,
       r.source_ref_id AS invoice_no,
       TO_CHAR(r.created_at, 'YYYY-MM-DD') AS invoice_date,
       TO_CHAR(r.due_date, 'YYYY-MM-DD') AS due_date_str,
       r.outstanding_amount,
       -- date - date is a day count; GREATEST ignores a NULL due date (Current).
       GREATEST(0, (CURRENT_DATE - r.due_date))::int AS days_overdue,
       -- The receivable changes only when a payment is applied, so its last
       -- update is the last payment once anything has been collected.
       CASE WHEN r.outstanding_amount < r.original_amount
            THEN TO_CHAR(r.updated_at, 'YYYY-MM-DD') ELSE NULL END AS last_payment_date_str
     FROM receivables r
     LEFT JOIN customers c ON c.id = r.customer_id
     ${where([`r.status IN ('Pending', 'PartiallyPaid', 'Overdue')`, ...(branchId ? ['r.branch_id = $1'] : [])])}
     ORDER BY days_overdue DESC, r.due_date ASC NULLS LAST`,
    params,
  );
}

/** Every receivable raised in the range, of every source (orders, POS, exchanges). */
export async function receivablesRaised(q: Queryable, scope: ReportScope): Promise<Record<string, unknown>[]> {
  const { conditions, params } = scopeConditions(scope, 'r');
  return reportRows(
    q,
    `SELECT
       TO_CHAR(r.created_at, 'YYYY-MM-DD') AS date_str,
       r.original_amount,
       r.outstanding_amount,
       COALESCE(r.written_off_amount, 0) + COALESCE(r.cancelled_amount, 0) + r.credited_amount AS closed_amount,
       TO_CHAR(r.due_date, 'YYYY-MM-DD') AS due_date_str,
       GREATEST(0, EXTRACT(DAY FROM now() - r.due_date)::int) AS days_overdue,
       r.source_ref_id AS order_reference,
       COALESCE(c.full_name, 'Unknown') AS customer_name,
       r.status AS payment_status
     FROM receivables r
     LEFT JOIN customers c ON c.id = r.customer_id
     ${where(conditions)}
     ORDER BY r.due_date ASC NULLS LAST, r.created_at DESC`,
    params,
  );
}
