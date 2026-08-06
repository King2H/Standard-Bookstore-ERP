'use strict';

// Order–Payment–Inventory Lifecycle Bugfix — extend inventory_history.reference_type
//
// Adds 'order_fulfilled' and 'order_return' to the allowed reference_type values so
// that inventory_history records can be written:
//   - 'order_fulfilled' : written by fulfillReservation() when an order is fulfilled
//                         (delta = 0, qty unchanged — reservation transitions to 'deducted')
//   - 'order_return'    : written by createReturn() when items from an order are returned
//                         (SELLABLE: stock restored; DAMAGED: damaged_quantity updated)
//
// Current allowed values (from migration 37):
//   purchase_order, return, adjustment, manual, initial_stock,
//   sale, void, pos_return, order,
//   exchange_in, exchange_out, exchange_damaged,
//   order_confirmed, order_cancelled
//
// (Migrations 39, 40, and 41 exist in the DB but not in this repo — they added unrelated
// features. This migration picks up from the current DB constraint state.)
//
// New values added:
//   order_fulfilled, order_return

exports.shorthands = undefined;

exports.up = function (pgm) {
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
        'order_fulfilled', 'order_return'
      ));
  `);
};

exports.down = function (pgm) {
  // Restore the constraint to the state before this migration
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order', 'return', 'adjustment', 'manual', 'initial_stock',
        'sale', 'void', 'pos_return', 'order',
        'exchange_in', 'exchange_out', 'exchange_damaged',
        'order_confirmed', 'order_cancelled'
      ));
  `);
};
