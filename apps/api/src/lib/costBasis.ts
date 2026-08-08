// ── Shared cost-basis lookup ────────────────────────────────────────────────
//
// Single source of truth for "what did this book cost us", used everywhere
// COGS/profit/valuation needs a per-book unit cost (reports.service.ts,
// profit.service.ts). Two sources, in priority order:
//
//   1. Most recent procurement unit cost (po_line_items) — authoritative once
//      a book has ever been formally purchased through Procurement.
//   2. Falls back to the most recent Customer Exchange receiving cost
//      (inventory_history.unit_cost, reference_type='customer_exchange') for
//      books that have NEVER been procured — Non-Destructive Catalog Search
//      & Virtual Receiving's whole point is that such units still carry a
//      real, non-zero cost basis (the trade-in allowance paid to the
//      customer) instead of silently costing $0, which would inflate every
//      profit/COGS figure downstream.
//   3. NULL (callers already COALESCE this to 0) if neither source has ever
//      recorded a cost for this book.
//
// Mirrors the existing "most recent PO line item wins" simplification
// (`ORDER BY pli.id DESC LIMIT 1`) already used everywhere in this codebase —
// there is no FIFO/weighted-average lot costing anywhere, so this fallback
// intentionally doesn't introduce one either; it just adds a second source
// or the same "single blended value" model already treats as authoritative.

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
         WHERE pli.book_id = ${bookIdExpr}
         UNION ALL
         SELECT ih.unit_cost, 1 AS source_priority, ih.id AS rank_id
         FROM inventory_history ih
         WHERE ih.book_id = ${bookIdExpr} AND ih.unit_cost IS NOT NULL
       ) combined
       ORDER BY source_priority ASC, rank_id DESC
       LIMIT 1
     ) ${alias} ON true`;
}
