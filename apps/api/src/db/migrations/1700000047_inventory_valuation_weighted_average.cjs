'use strict';

// Inventory Valuation, Returns, Exchanges & Procurement Accounting
// Standardization — schema layer.
//
// Establishes the data model needed for Weighted Average (Moving Average)
// inventory costing, per-line persisted sale-time cost (so historical COGS
// stops silently changing whenever a later purchase order lands at a
// different price — see costBasis.ts, whose own header already documents
// that no such costing existed before this migration), and return/exchange
// cost-basis integrity.
//
// Entirely additive — no column is renamed, retyped, or dropped, and no
// existing row's data is altered beyond the one-time average_cost seed
// described below. `inventory.quantity` is kept as-is (not renamed to
// quantity_on_hand) since it already carries that exact meaning and is
// read by a large number of existing call sites; renaming it would be a
// purely cosmetic, high-blast-radius change for no behavioral gain.

exports.shorthands = undefined;

exports.up = async function (pgm) {
  // ── inventory: weighted-average cost + derived value ────────────────────
  pgm.addColumn('inventory', {
    average_cost: { type: 'numeric(14,4)', notNull: true, default: 0 },
  });
  pgm.addConstraint('inventory', 'inventory_average_cost_nonneg', 'CHECK (average_cost >= 0)');

  // inventory_value is derived, never written directly — GENERATED keeps it
  // impossible to drift out of sync with quantity/average_cost.
  pgm.sql(`
    ALTER TABLE inventory
      ADD COLUMN inventory_value NUMERIC(14,2)
      GENERATED ALWAYS AS (ROUND(quantity * average_cost, 2)) STORED;
  `);

  // ── inventory_history: total_cost alongside the existing unit_cost ──────
  // (unit_cost itself already exists — added in migration 46 for Customer
  // Exchange receiving; this just adds the matching extended total.)
  pgm.addColumn('inventory_history', {
    total_cost: { type: 'numeric(14,2)', notNull: false },
  });

  // ── Sale-time cost persistence — the core of this migration ─────────────
  // Nullable: historical rows predating this migration keep NULL and fall
  // back to the pre-existing costBasis.ts lookup (see the application-code
  // changes accompanying this migration); every new sale/order/exchange
  // going forward always populates it.
  pgm.addColumn('order_line_items', {
    unit_cost: { type: 'numeric(14,2)', notNull: false },
  });
  pgm.addColumn('transaction_line_items', {
    unit_cost: { type: 'numeric(14,2)', notNull: false },
  });
  pgm.addColumn('exchange_outgoing_items', {
    unit_cost: { type: 'numeric(14,2)', notNull: false },
  });
  pgm.addColumn('exchange_items', {
    unit_cost: { type: 'numeric(14,2)', notNull: false },
  });

  // ── One-time seed of average_cost for existing stock ────────────────────
  // Best-effort starting point only, not a claim of exact historical
  // reconstruction (that data was never captured) — uses the same
  // "most-recent-cost" priority order costBasis.ts already used everywhere
  // (procurement PO line items first, falling back to Customer Exchange
  // receiving cost), so the transition doesn't jar existing valuation
  // reports from a real number down to zero. Only rows with quantity > 0
  // and a resolvable cost are touched; everything else keeps the default 0
  // (a book that has genuinely never had a recorded cost).
  pgm.sql(`
    UPDATE inventory i
    SET average_cost = seed.unit_cost
    FROM (
      SELECT DISTINCT ON (b.id)
        b.id AS book_id,
        combined.unit_cost
      FROM books b
      CROSS JOIN LATERAL (
        SELECT pli.unit_cost, 0 AS source_priority, pli.id AS rank_id
        FROM po_line_items pli
        WHERE pli.book_id = b.id
        UNION ALL
        SELECT ih.unit_cost, 1 AS source_priority, ih.id AS rank_id
        FROM inventory_history ih
        WHERE ih.book_id = b.id AND ih.unit_cost IS NOT NULL
      ) combined
      ORDER BY b.id, combined.source_priority ASC, combined.rank_id DESC
    ) seed
    WHERE i.book_id = seed.book_id AND i.quantity > 0;
  `);
};

exports.down = function (pgm) {
  pgm.dropColumn('exchange_items', 'unit_cost');
  pgm.dropColumn('exchange_outgoing_items', 'unit_cost');
  pgm.dropColumn('transaction_line_items', 'unit_cost');
  pgm.dropColumn('order_line_items', 'unit_cost');
  pgm.dropColumn('inventory_history', 'total_cost');
  pgm.sql(`ALTER TABLE inventory DROP COLUMN IF EXISTS inventory_value;`);
  pgm.dropConstraint('inventory', 'inventory_average_cost_nonneg');
  pgm.dropColumn('inventory', 'average_cost');
};
