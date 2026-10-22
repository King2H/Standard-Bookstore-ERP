'use strict';

// Corrects the repair of 1700000072 (#163). That repair took a book's newest
// purchase-order price as its cost, also from orders that delivered nothing (a
// draft, an order waiting, approved, ordered or cancelled): a quote, not a
// cost. A shop's 5 copies of a book never received were valued at a draft's
// 30.00 each.
//
// For each row the repair changed, while its cost is still the one the repair
// set (no stock has moved it since), the cost is worked out again from what
// had arrived before the repair ran: the newest purchase-order line that
// delivered copies, else the newest cost recorded on stock arriving
// (lib/costBasis.ts), else none (0, flagged by `npm run db:check` and given a
// cost with Inventory's Set cost). Each change is written to the audit log,
// naming the repair entry it corrects. Running it again changes nothing.
//
// No schema change. The down migration leaves the corrected costs.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    WITH repaired AS (
      SELECT a.id AS audit_id, a.tenant_id, a.created_at AS repaired_at,
             (a.meta->>'bookId')::int AS book_id, (a.meta->>'locationId')::int AS location_id,
             (a.meta->>'averageCostAfter')::numeric AS repaired_cost
      FROM audit_logs a
      WHERE a.entity_type = 'inventory_cost' AND a.staff_id IS NULL AND a.meta->>'reason' LIKE 'Repair (#163)%'
        AND NOT EXISTS (
          SELECT 1 FROM audit_logs c
          WHERE c.entity_type = 'inventory_cost' AND c.meta->>'corrects' = a.id::text
        )
    ), target AS (
      SELECT r.*, i.quantity, COALESCE(lc.unit_cost, 0) AS corrected_cost
      FROM repaired r
      JOIN inventory i ON i.book_id = r.book_id AND i.location_id = r.location_id
      LEFT JOIN LATERAL (
        SELECT unit_cost FROM (
          SELECT pli.unit_cost, 0 AS source_priority, pli.id AS rank_id
          FROM po_line_items pli
          WHERE pli.book_id = r.book_id AND pli.received_quantity > 0 AND pli.unit_cost > 0
          UNION ALL
          SELECT ih.unit_cost, 1 AS source_priority, ih.id AS rank_id
          FROM inventory_history ih
          WHERE ih.book_id = r.book_id AND ih.unit_cost > 0 AND ih.created_at < r.repaired_at
            AND (ih.movement_type IN ('stock_in', 'transfer_in') OR ih.reason_code = 'revaluation')
        ) combined
        ORDER BY source_priority ASC, rank_id DESC
        LIMIT 1
      ) lc ON true
      WHERE i.average_cost = r.repaired_cost AND COALESCE(lc.unit_cost, 0) <> r.repaired_cost
    ), corrected AS (
      UPDATE inventory i
         SET average_cost = t.corrected_cost, updated_at = now()
        FROM target t
       WHERE i.book_id = t.book_id AND i.location_id = t.location_id
      RETURNING t.audit_id, t.tenant_id, t.book_id, t.location_id, t.quantity, t.repaired_cost, t.corrected_cost
    )
    INSERT INTO audit_logs (tenant_id, staff_id, staff_role, action, entity_type, entity_id, meta)
    SELECT tenant_id, NULL, 'system', 'UPDATE', 'inventory_cost', book_id || ':' || location_id,
           jsonb_build_object(
             'bookId', book_id,
             'locationId', location_id,
             'quantity', quantity,
             'averageCostBefore', to_char(repaired_cost, 'FM999999999990.0000'),
             'averageCostAfter', to_char(corrected_cost, 'FM999999999990.0000'),
             'reason', 'Correction (#163): the repair took a price from a purchase order that delivered nothing; only copies that arrived have a cost',
             'corrects', audit_id
           )
    FROM corrected;
  `);
};

exports.down = function () {};
