'use strict';

// Order Inventory Sync — extend inventory_history.reference_type
//
// Adds 'order_confirmed' and 'order_cancelled' to the allowed reference_type
// values so that inventory_history records can be written when an order is
// confirmed (stock deducted) or cancelled (stock restored).
//
// Current allowed values (from migration 33 / 27):
//   purchase_order, return, adjustment, manual, initial_stock,
//   sale, void, pos_return, order,
//   exchange_in, exchange_out, exchange_damaged
//
// New allowed values add:
//   order_confirmed, order_cancelled

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
        'order_confirmed', 'order_cancelled'
      ));
  `);
};

exports.down = function (pgm) {
  // Restore the constraint to the state after migration 33
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order', 'return', 'adjustment', 'manual', 'initial_stock',
        'sale', 'void', 'pos_return', 'order',
        'exchange_in', 'exchange_out', 'exchange_damaged'
      ));
  `);
};
