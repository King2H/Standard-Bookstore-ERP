'use strict';

// Non-Destructive Catalog Search & Virtual Receiving for Incoming Exchanges
//
// Adds a per-movement unit_cost to inventory_history (nullable — only stock-in
// events that establish a real cost basis populate it; every other existing
// movement type keeps writing NULL exactly as before, so this is purely
// additive) and extends the reference_type CHECK constraint with
// 'customer_exchange' — the SOURCE tag for "virtual receiving": an incoming
// exchange item's stockIn() is now tagged distinctly from a plain
// 'exchange_in' (resellable customer return of a book the customer bought
// from us) so the two are traceable/reportable separately, and carries the
// Customer Allowance Value as unit_cost so a book that was never procured
// through Procurement still gets a real, non-zero cost basis instead of
// silently costing $0 in COGS/profit reporting.
//
// Current allowed reference_type values (from migration 44):
//   purchase_order, return, adjustment, manual, initial_stock,
//   sale, void, pos_return, order,
//   exchange_in, exchange_out, exchange_damaged,
//   order_confirmed, order_cancelled,
//   order_fulfilled, order_return,
//   transfer
//
// New value added:
//   customer_exchange

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.addColumn('inventory_history', {
    unit_cost: { type: 'numeric(14,2)', notNull: false },
  });
  pgm.addConstraint('inventory_history', 'inventory_history_unit_cost_nonneg', 'CHECK (unit_cost IS NULL OR unit_cost >= 0)');

  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order', 'return', 'adjustment', 'manual', 'initial_stock',
        'sale', 'void', 'pos_return', 'order',
        'exchange_in', 'exchange_out', 'exchange_damaged',
        'order_confirmed', 'order_cancelled',
        'order_fulfilled', 'order_return',
        'transfer',
        'customer_exchange'
      ));
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order', 'return', 'adjustment', 'manual', 'initial_stock',
        'sale', 'void', 'pos_return', 'order',
        'exchange_in', 'exchange_out', 'exchange_damaged',
        'order_confirmed', 'order_cancelled',
        'order_fulfilled', 'order_return',
        'transfer'
      ));
  `);
  pgm.dropConstraint('inventory_history', 'inventory_history_unit_cost_nonneg');
  pgm.dropColumn('inventory_history', 'unit_cost');
};
