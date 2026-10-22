'use strict';

// Stock held at cost 0 gets the book's latest known cost (#163, decision 3a).
//
// Manual stock-in carried no cost, and stock coming back without one kept a
// location's average of 0, so those copies were valued at 0. Rows with copies
// on hand and an average cost of 0 take the cost the reports' cost basis
// gives (lib/costBasis.ts): the newest purchase-order cost, else the newest
// cost a stock movement recorded, never 0. Each repaired row is written to the
// audit log. Rows for books with no known cost stay at 0: `npm run db:check`
// lists them, and Inventory's Set cost gives them one.
//
// No schema change. The down migration leaves the costs as repaired: the old
// value, 0, was the fault.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    WITH known AS (
      SELECT i.tenant_id, i.book_id, i.location_id, i.quantity, lc.unit_cost
      FROM inventory i
      JOIN LATERAL (
        SELECT unit_cost FROM (
          SELECT pli.unit_cost, 0 AS source_priority, pli.id AS rank_id
          FROM po_line_items pli
          WHERE pli.book_id = i.book_id AND pli.unit_cost > 0
          UNION ALL
          SELECT ih.unit_cost, 1 AS source_priority, ih.id AS rank_id
          FROM inventory_history ih
          WHERE ih.book_id = i.book_id AND ih.unit_cost > 0
        ) combined
        ORDER BY source_priority ASC, rank_id DESC
        LIMIT 1
      ) lc ON true
      WHERE i.quantity > 0 AND i.average_cost = 0
    ), repaired AS (
      UPDATE inventory i
         SET average_cost = k.unit_cost, updated_at = now()
        FROM known k
       WHERE i.book_id = k.book_id AND i.location_id = k.location_id
      RETURNING k.tenant_id, k.book_id, k.location_id, k.quantity, k.unit_cost
    )
    INSERT INTO audit_logs (tenant_id, staff_id, staff_role, action, entity_type, entity_id, meta)
    SELECT tenant_id, NULL, 'system', 'UPDATE', 'inventory_cost', book_id || ':' || location_id,
           jsonb_build_object(
             'bookId', book_id,
             'locationId', location_id,
             'quantity', quantity,
             'averageCostBefore', '0.0000',
             'averageCostAfter', to_char(unit_cost, 'FM999999999990.0000'),
             'reason', 'Repair (#163): stock held at cost 0 valued at the book''s latest known cost'
           )
    FROM repaired;
  `);
};

exports.down = function () {};
