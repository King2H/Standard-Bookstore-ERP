import type { Queryable } from '../../../db/tx.js';
import { reportRows } from '../../../db/reportDb.js';
import { costBasisLateralJoin } from '../../../lib/costBasis.js';
import { scopeConditions, where, type ReportFilters, type ReportScope } from '../reportScope.js';

// Stock reports (#22). Stock levels are a balance now; sales and movements
// are flows over the date range, both ends included.

const branchOfLocation = (branchId: number | undefined): { cond: string; params: unknown[] } =>
  branchId ? { cond: 'l.branch_id = $1', params: [branchId] } : { cond: '', params: [] };

export interface StockSummaryRow {
  total_books: number; total_units: number; available_stock: number;
  reserved_stock: number; low_stock: number; out_of_stock: number;
}

export async function stockSummary(q: Queryable, branchId: number | undefined): Promise<StockSummaryRow> {
  const b = branchOfLocation(branchId);
  const [row] = await reportRows<StockSummaryRow>(
    q,
    `SELECT
       COUNT(DISTINCT i.book_id)::INTEGER AS total_books,
       COALESCE(SUM(i.quantity), 0)::INTEGER AS total_units,
       -- Confirming an order already takes the stock out; the reservation is
       -- bookkeeping, not a second hold, so available stock is the quantity.
       COALESCE(SUM(i.quantity), 0)::INTEGER AS available_stock,
       COALESCE(SUM(COALESCE(r.reserved, 0)), 0)::INTEGER AS reserved_stock,
       COUNT(CASE WHEN i.quantity <= i.reorder_point AND i.quantity > 0 THEN 1 END)::INTEGER AS low_stock,
       COUNT(CASE WHEN i.quantity = 0 THEN 1 END)::INTEGER AS out_of_stock
     FROM inventory i
     JOIN locations l ON l.id = i.location_id
     LEFT JOIN (
       SELECT book_id, location_id, COALESCE(SUM(quantity), 0) AS reserved
       FROM inventory_reservations WHERE status = 'reserved'
       GROUP BY book_id, location_id
     ) r ON r.book_id = i.book_id AND r.location_id = i.location_id
     ${where(b.cond ? [b.cond] : [])}`,
    b.params,
  );
  return row;
}

export async function lowStock(
  q: Queryable,
  branchId: number | undefined,
): Promise<Array<{ book_id: number; title: string; location_id: number; location_name: string; quantity: number; reorder_point: number }>> {
  const b = branchOfLocation(branchId);
  return reportRows(
    q,
    `SELECT i.book_id, b.title, i.location_id, l.name AS location_name, i.quantity, i.reorder_point
     FROM inventory i
     JOIN books b ON b.id = i.book_id
     JOIN locations l ON l.id = i.location_id
     ${where(['i.quantity <= i.reorder_point', ...(b.cond ? [b.cond] : [])])}
     ORDER BY i.quantity ASC
     LIMIT 50`,
    b.params,
  );
}

/** The books sold most at POS in the range. */
export async function topSelling(
  q: Queryable,
  scope: ReportScope,
): Promise<Array<{ book_id: number; title: string; units_sold: number; revenue: string }>> {
  const { conditions, params } = scopeConditions(scope, 't');
  return reportRows(
    q,
    `SELECT li.book_id, b.title,
            SUM(li.quantity)::INTEGER AS units_sold,
            COALESCE(SUM(li.line_total), 0)::NUMERIC AS revenue
     FROM transaction_line_items li
     JOIN transactions t ON t.id = li.transaction_id
     JOIN books b ON b.id = li.book_id
     ${where([`t.status = 'completed'`, ...conditions])}
     GROUP BY li.book_id, b.title
     ORDER BY units_sold DESC
     LIMIT 20`,
    params,
  );
}

/** Units in and out per day, week or month (the bucket name is from a fixed list, never request text). */
export async function stockMovement(
  q: Queryable,
  filters: ReportFilters,
): Promise<Array<{ period: string; stock_in: number; stock_out: number }>> {
  const { conditions, params } = scopeConditions(filters, 'ih', { branchAlias: 'l' });
  const bucket = `date_trunc('${filters.groupBy}', ih.created_at)`;
  return reportRows(
    q,
    `SELECT ${bucket}::TEXT AS period,
            COALESCE(SUM(CASE WHEN ih.delta > 0 THEN ih.delta ELSE 0 END), 0)::INTEGER AS stock_in,
            COALESCE(SUM(CASE WHEN ih.delta < 0 THEN ABS(ih.delta) ELSE 0 END), 0)::INTEGER AS stock_out
     FROM inventory_history ih
     JOIN locations l ON l.id = ih.location_id
     ${where(conditions)}
     GROUP BY ${bucket}
     ORDER BY ${bucket}`,
    params,
  );
}

/** One row per book and location: quantities, valuation and the last prices. */
export async function stockRows(q: Queryable, branchId: number | undefined): Promise<Record<string, unknown>[]> {
  const b = branchOfLocation(branchId);
  return reportRows(
    q,
    `SELECT
       i.book_id,
       COALESCE(b.sku, b.isbn) AS book_code,
       b.isbn,
       b.title,
       COALESCE(b.publisher, '') AS publisher,
       COALESCE(string_agg(DISTINCT a.name, ', ' ORDER BY a.name), '') AS author,
       COALESCE(
         (SELECT string_agg(cat.name, ', ' ORDER BY cat.name)
          FROM book_categories bc2
          JOIN categories cat ON cat.id = bc2.category_id
          WHERE bc2.book_id = b.id),
         ''
       ) AS category,
       i.quantity AS quantity_on_hand,
       -- Confirming an order already takes the stock out: reserved is for
       -- information, available is the quantity.
       COALESCE(res.reserved, 0)::int AS quantity_reserved,
       i.quantity::int AS quantity_available,
       -- The location's weighted average cost values what is on hand there;
       -- the latest known cost only while nothing valued has arrived yet.
       COALESCE(NULLIF(i.average_cost, 0), lc.unit_cost, 0)::NUMERIC AS unit_cost,
       i.inventory_value,
       TO_CHAR(
         (SELECT MAX(ih.created_at) FROM inventory_history ih
          WHERE ih.book_id = i.book_id AND ih.location_id = i.location_id),
         'YYYY-MM-DD'
       ) AS last_movement_date_str,
       (SELECT pli.unit_cost FROM po_line_items pli
        WHERE pli.book_id = b.id ORDER BY pli.id DESC LIMIT 1) AS last_purchase_cost,
       COALESCE(bbp.price, b.default_price) AS last_selling_price
     FROM inventory i
     JOIN books b ON b.id = i.book_id
     JOIN locations l ON l.id = i.location_id
     LEFT JOIN book_authors ba ON ba.book_id = b.id
     LEFT JOIN authors a ON a.id = ba.author_id
     LEFT JOIN book_branch_prices bbp ON bbp.book_id = b.id AND bbp.branch_id = l.branch_id
       AND bbp.format_id = 0 AND bbp.edition_id = 0
     LEFT JOIN (
       SELECT book_id, location_id, SUM(quantity)::int AS reserved
       FROM inventory_reservations WHERE status = 'reserved'
       GROUP BY book_id, location_id
     ) res ON res.book_id = i.book_id AND res.location_id = i.location_id
     ${costBasisLateralJoin('b.id')}
     ${where(b.cond ? [b.cond] : [])}
     GROUP BY b.id, i.book_id, b.sku, b.isbn, b.title, b.publisher, i.location_id,
              i.quantity, i.average_cost, i.inventory_value, res.reserved, lc.unit_cost,
              bbp.price, b.default_price
     ORDER BY b.title ASC`,
    b.params,
  );
}
