'use strict';

// Damaged copies keep their cost (#168, owner decision 2a, 2026-10-24).
//
// Damaged copies are counted apart from the stock for sale. They now keep
// their value apart too: a damaged return brings the cost the books left at,
// a repair puts the copies back for sale at that cost, and a write-off takes
// the value out as a loss. Copies counted damaged before have no cost on
// record, so they start at 0.
//
// Running it again changes nothing.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE inventory ADD COLUMN IF NOT EXISTS damaged_value numeric(14,2) NOT NULL DEFAULT 0;
    ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_damaged_value_check;
    ALTER TABLE inventory ADD CONSTRAINT inventory_damaged_value_check
      CHECK (damaged_value >= 0 AND (COALESCE(damaged_quantity, 0) > 0 OR damaged_value = 0));
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_damaged_value_check;
    ALTER TABLE inventory DROP COLUMN IF EXISTS damaged_value;
  `);
};
