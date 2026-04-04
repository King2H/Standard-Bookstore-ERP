'use strict';

// Slice 7.x — Inventory Stock In / Stock Out
// Adds movement_type, reference_type, reference_id to inventory_history.
// Backfills existing rows based on reason_code.

exports.shorthands = undefined;

exports.up = function (pgm) {
  // Add new columns to the partitioned table (applies to all partitions)
  pgm.sql(`
    ALTER TABLE inventory_history
      ADD COLUMN movement_type  TEXT NOT NULL DEFAULT 'adjustment'
        CHECK (movement_type IN ('stock_in','stock_out','transfer_in','transfer_out','adjustment')),
      ADD COLUMN reference_type TEXT,
      ADD COLUMN reference_id   BIGINT;
  `);

  // Backfill movement_type from existing reason_code values
  pgm.sql(`
    UPDATE inventory_history SET movement_type = 'transfer_in'  WHERE reason_code = 'transfer_in';
    UPDATE inventory_history SET movement_type = 'transfer_out' WHERE reason_code = 'transfer_out';
    UPDATE inventory_history SET movement_type = 'adjustment'
      WHERE reason_code IN ('damage','loss','return','correction','initial');
  `);

  // Index for filtering by movement_type
  pgm.sql(`CREATE INDEX inventory_history_movement_type_idx ON inventory_history (movement_type)`);
};

exports.down = function (pgm) {
  pgm.sql(`DROP INDEX IF EXISTS inventory_history_movement_type_idx`);
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP COLUMN IF EXISTS movement_type,
      DROP COLUMN IF EXISTS reference_type,
      DROP COLUMN IF EXISTS reference_id;
  `);
};
