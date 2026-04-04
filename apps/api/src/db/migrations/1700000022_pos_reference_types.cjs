'use strict';

// Slice 11 — POS reference types for inventory_history
// Extends the reference_type CHECK constraint to include 'sale' and 'void'.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
  `);

  pgm.sql(`
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order','return','adjustment','manual','initial_stock','sale','void'
      ));
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
  `);

  pgm.sql(`
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order','return','adjustment','manual','initial_stock'
      ));
  `);
};
