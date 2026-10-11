import type { Queryable } from '../../../db/tx.js';
import { reportRows } from '../../../db/reportDb.js';
import { scopeConditions, where, type ReportFilters, type ReportScope } from '../reportScope.js';

// Exchange reports (#22). Only completed exchanges count: a voided exchange
// (status Cancelled) was undone, its books and money handed back.

const COMPLETED = `e.status IN ('Completed', 'COMPLETED')`;

export async function exchangeTotals(
  q: Queryable,
  scope: ReportScope,
): Promise<{ total_exchanges: number; total_incoming: string; total_outgoing: string; net_impact: string }> {
  const { conditions, params } = scopeConditions(scope, 'e');
  const [row] = await reportRows<{ total_exchanges: number; total_incoming: string; total_outgoing: string; net_impact: string }>(
    q,
    `SELECT COUNT(*)::INTEGER AS total_exchanges,
            COALESCE(SUM(e.total_incoming_value), 0)::NUMERIC AS total_incoming,
            COALESCE(SUM(e.total_outgoing_value), 0)::NUMERIC AS total_outgoing,
            COALESCE(SUM(e.net_balance), 0)::NUMERIC AS net_impact
     FROM exchanges e ${where([COMPLETED, ...conditions])}`,
    params,
  );
  return row;
}

export async function bySettlementType(
  q: Queryable,
  scope: ReportScope,
): Promise<Array<{ settlement_type: string; count: number; total_net_balance: string }>> {
  const { conditions, params } = scopeConditions(scope, 'e');
  return reportRows(
    q,
    `SELECT e.settlement_type, COUNT(*)::INTEGER AS count, COALESCE(SUM(e.net_balance), 0)::NUMERIC AS total_net_balance
     FROM exchanges e ${where([COMPLETED, ...conditions])}
     GROUP BY e.settlement_type
     ORDER BY count DESC`,
    params,
  );
}

/** Exchanges per day, week or month (the bucket name is from a fixed list, never request text). */
export async function byPeriod(
  q: Queryable,
  filters: ReportFilters,
): Promise<Array<{ period: string; count: number; incoming_value: string; outgoing_value: string }>> {
  const { conditions, params } = scopeConditions(filters, 'e');
  const bucket = `date_trunc('${filters.groupBy}', e.created_at)`;
  return reportRows(
    q,
    `SELECT ${bucket}::TEXT AS period, COUNT(*)::INTEGER AS count,
            COALESCE(SUM(e.total_incoming_value), 0)::NUMERIC AS incoming_value,
            COALESCE(SUM(e.total_outgoing_value), 0)::NUMERIC AS outgoing_value
     FROM exchanges e ${where([COMPLETED, ...conditions])}
     GROUP BY ${bucket}
     ORDER BY ${bucket}`,
    params,
  );
}

/** One row per completed exchange; several books in one leg are listed together. */
export async function exchangeRows(q: Queryable, scope: ReportScope): Promise<Record<string, unknown>[]> {
  const { conditions, params } = scopeConditions(scope, 'e');
  return reportRows(
    q,
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
     ${where([COMPLETED, ...conditions])}
     ORDER BY e.created_at DESC`,
    params,
  );
}
