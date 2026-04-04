'use strict';

// Slice 8.4 — Add CHECK constraint to inventory_history.reference_type
// The column already exists from migration 1700000015.

exports.shorthands = undefined;

exports.up = function (pgm) {
  // Add CHECK constraint to reference_type (column already exists from migration 15)
  pgm.sql(`
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN ('purchase_order','return','adjustment','manual','initial_stock'));
  `);

  // Backfill: set reference_type='manual' for stock_in rows that have NULL reference_type
  pgm.sql(`
    UPDATE inventory_history
    SET reference_type = 'manual'
    WHERE movement_type = 'stock_in' AND reference_type IS NULL;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE inventory_history DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
  `);
};
