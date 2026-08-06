'use strict';

// Inventory transfer traceability fix — extend inventory_history.reference_type
//
// transferStock() (inventoryTransaction.service.ts) generates a shared batch
// id ("for traceability", per its own comment) when moving stock between
// locations, but the reference_type/reference_id columns were hardcoded NULL
// on both the transfer_out and transfer_in rows it writes — the batch id only
// ever ended up embedded in the free-text `notes` string. That's because
// 'transfer' was never added to this CHECK constraint's allowed list in the
// first place, and reference_id is bigint (the batch id string wouldn't have
// fit anyway). Any report/reconciliation filtering inventory_history by
// reference_type='transfer', or correlating a transfer_out row with its
// paired transfer_in row via reference_id, found nothing.
//
// Current allowed values (from migration 42):
//   purchase_order, return, adjustment, manual, initial_stock,
//   sale, void, pos_return, order,
//   exchange_in, exchange_out, exchange_damaged,
//   order_confirmed, order_cancelled, order_fulfilled, order_return
//
// New value added:
//   transfer

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
        'order_fulfilled', 'order_return',
        'transfer'
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
        'order_confirmed', 'order_cancelled',
        'order_fulfilled', 'order_return'
      ));
  `);
};
