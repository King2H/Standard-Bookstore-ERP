'use strict';

// Slice 9 refinement — Flexible receiving destination + financial_status tracking

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    -- Add receiving destination columns (nullable for backward compat with existing POs)
    ALTER TABLE purchase_orders
      ADD COLUMN IF NOT EXISTS receiving_branch_id   INTEGER REFERENCES branches(id),
      ADD COLUMN IF NOT EXISTS receiving_location_id INTEGER REFERENCES locations(id),
      ADD COLUMN IF NOT EXISTS financial_status      TEXT NOT NULL DEFAULT 'unpaid'
                                                       CHECK (financial_status IN ('unpaid','partial','paid'));

    -- Backfill existing POs: set receiving_branch_id = branch_id
    UPDATE purchase_orders
    SET receiving_branch_id = branch_id
    WHERE receiving_branch_id IS NULL;

    -- Backfill receiving_location_id to the default fulfillment location of the branch
    UPDATE purchase_orders po
    SET receiving_location_id = (
      SELECT l.id FROM locations l
      WHERE l.branch_id = po.branch_id
        AND l.is_default_fulfillment = true
      LIMIT 1
    )
    WHERE receiving_location_id IS NULL;

    -- Index for filtering by receiving branch
    CREATE INDEX IF NOT EXISTS purchase_orders_receiving_branch_idx
      ON purchase_orders (receiving_branch_id);
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE purchase_orders
      DROP COLUMN IF EXISTS receiving_branch_id,
      DROP COLUMN IF EXISTS receiving_location_id,
      DROP COLUMN IF EXISTS financial_status;
    DROP INDEX IF EXISTS purchase_orders_receiving_branch_idx;
  `);
};
