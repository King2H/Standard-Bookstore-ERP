// ── Shared cost-basis lookup ────────────────────────────────────────────────
//
// Single source of truth for "what did this book cost us", used everywhere
// COGS/profit/valuation needs a per-book unit cost (the reports,
// profit.service.ts), and by stock arriving without a cost
// (inventory.repository.ts latestKnownCost). Only copies that arrived have a
// cost (#163): a price on a purchase order that delivered nothing (a draft,
// an order waiting, approved, ordered or cancelled) is a quote, never a cost.
// Two sources, in priority order:
//
//   1. The most recent purchase-order line that delivered copies
//      (received_quantity > 0): what the shop paid its supplier.
//   2. The most recent cost recorded on stock arriving in the history: a
//      priced stock-in, a trade-in (the allowance paid to the customer), a
//      cost set by hand (Set cost), stock coming back at the cost it left at.
//   3. NULL (callers COALESCE this to 0) when neither ever recorded a cost.
//
// A cost of 0 is not a known cost: a sale out of stock that had no cost
// records 0.00, and free copies are 0 by choice; neither says what the book
// costs.
//
// Mirrors the "most recent purchase line wins" simplification used across
// the reports; there is no FIFO lot costing.

/**
 * Returns a `LEFT JOIN LATERAL (...) <alias> ON true` SQL fragment resolving
 * a book's unit cost. Selects `<alias>.unit_cost` in the outer query (usually
 * via `COALESCE(<alias>.unit_cost, 0)`, matching every existing call site).
 *
 * @param bookIdExpr - SQL expression for the book id column in the *outer*
 *   query this LATERAL is joined against (e.g. 'oli.book_id', 'b.id'). Must
 *   be a static column reference chosen by the caller, never user input.
 * @param alias - alias for the joined subquery (default 'lc', matching the
 *   pre-existing call sites this replaces).
 */
export function costBasisLateralJoin(bookIdExpr: string, alias = 'lc'): string {
  return `
     LEFT JOIN LATERAL (
       SELECT unit_cost FROM (
         SELECT pli.unit_cost, 0 AS source_priority, pli.id AS rank_id
         FROM po_line_items pli
         WHERE pli.book_id = ${bookIdExpr} AND pli.received_quantity > 0 AND pli.unit_cost > 0
         UNION ALL
         SELECT ih.unit_cost, 1 AS source_priority, ih.id AS rank_id
         FROM inventory_history ih
         WHERE ih.book_id = ${bookIdExpr} AND ih.unit_cost > 0
           AND (ih.movement_type IN ('stock_in', 'transfer_in') OR ih.reason_code = 'revaluation')
       ) combined
       ORDER BY source_priority ASC, rank_id DESC
       LIMIT 1
     ) ${alias} ON true`;
}
