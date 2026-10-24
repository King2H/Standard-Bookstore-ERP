import type { Queryable } from '../../../db/tx.js';
import { reportRows } from '../../../db/reportDb.js';
import { costBasisLateralJoin } from '../../../lib/costBasis.js';
import { scopeConditions, where, type ReportScope } from '../reportScope.js';

// Return reports (#22). The cost given back is the sold line's own frozen
// cost (the same line the return restocked against), never today's average.

export async function returnLines(q: Queryable, scope: ReportScope): Promise<Record<string, unknown>[]> {
  const { conditions, params } = scopeConditions(scope, 'r');
  return reportRows(
    q,
    `SELECT
       TO_CHAR(r.created_at, 'YYYY-MM-DD') AS return_date,
       r.return_number, COALESCE(t.transaction_number, o.order_number) AS original_invoice_no,
       COALESCE(c.full_name, 'Walk-in') AS customer_name,
       b.title AS book_title,
       rli.quantity, rli.line_refund_amount,
       COALESCE(otli.unit_cost, ooli.unit_cost, lc.unit_cost, 0) AS resolved_unit_cost,
       r.refund_method, s.username AS staff_username
     FROM return_line_items rli
     JOIN returns r ON r.id = rli.return_id
     JOIN books b ON b.id = rli.book_id
     LEFT JOIN transactions t ON t.id = r.transaction_id
     LEFT JOIN orders o ON o.id = r.order_id
     LEFT JOIN customers c ON c.id = r.customer_id
     LEFT JOIN staff s ON s.id = r.processed_by
     LEFT JOIN transaction_line_items otli ON otli.id = rli.transaction_line_item_id
     LEFT JOIN order_line_items ooli ON ooli.id = rli.order_line_item_id
     ${costBasisLateralJoin('rli.book_id')}
     ${where([...conditions, `r.status = 'completed'`])}
     ORDER BY r.created_at DESC`,
    params,
  );
}

export async function topReturned(
  q: Queryable,
  scope: ReportScope,
  limit: number,
): Promise<Array<{ book_id: number; title: string; units_returned: number; refund_value: string }>> {
  const { conditions, params } = scopeConditions(scope, 'r');
  params.push(limit);
  return reportRows(
    q,
    `SELECT rli.book_id, b.title,
            SUM(rli.quantity)::INTEGER AS units_returned,
            COALESCE(SUM(rli.line_refund_amount), 0)::NUMERIC AS refund_value
     FROM return_line_items rli
     JOIN returns r ON r.id = rli.return_id
     JOIN books b ON b.id = rli.book_id
     ${where([...conditions, `r.status = 'completed'`])}
     GROUP BY rli.book_id, b.title
     ORDER BY units_returned DESC
     LIMIT $${params.length}`,
    params,
  );
}
