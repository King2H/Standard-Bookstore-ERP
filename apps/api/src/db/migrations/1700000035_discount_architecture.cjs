'use strict';

// Discount Architecture Migration
// 1. Add discount_type and discount_mode columns to all line item tables
// 2. Add discount_pct to order_line_items (was missing, only had discount_amount)
// 3. Add discount_total to orders header
// 4. Seed default discount config keys

exports.shorthands = undefined;

exports.up = function (pgm) {

  // ── 1. transaction_line_items ──────────────────────────────────────────────
  pgm.sql(`
    ALTER TABLE transaction_line_items
      ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'Normal'
        CHECK (discount_type IN ('Normal','Merchant','Special')),
      ADD COLUMN IF NOT EXISTS discount_mode TEXT NOT NULL DEFAULT 'Percentage'
        CHECK (discount_mode IN ('Percentage','Amount'));
  `);

  // ── 2. order_line_items ────────────────────────────────────────────────────
  pgm.sql(`
    ALTER TABLE order_line_items
      ADD COLUMN IF NOT EXISTS discount_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'Normal'
        CHECK (discount_type IN ('Normal','Merchant','Special')),
      ADD COLUMN IF NOT EXISTS discount_mode TEXT NOT NULL DEFAULT 'Percentage'
        CHECK (discount_mode IN ('Percentage','Amount'));
  `);

  // ── 3. return_line_items ───────────────────────────────────────────────────
  pgm.sql(`
    ALTER TABLE return_line_items
      ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'Normal'
        CHECK (discount_type IN ('Normal','Merchant','Special')),
      ADD COLUMN IF NOT EXISTS discount_mode TEXT NOT NULL DEFAULT 'Percentage'
        CHECK (discount_mode IN ('Percentage','Amount'));
  `);

  // ── 4. exchange_outgoing_items ─────────────────────────────────────────────
  pgm.sql(`
    ALTER TABLE exchange_outgoing_items
      ADD COLUMN IF NOT EXISTS discount_pct    NUMERIC(5,2)  NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS discount_type   TEXT NOT NULL DEFAULT 'Normal'
        CHECK (discount_type IN ('Normal','Merchant','Special')),
      ADD COLUMN IF NOT EXISTS discount_mode   TEXT NOT NULL DEFAULT 'Percentage'
        CHECK (discount_mode IN ('Percentage','Amount'));
  `);

  // ── 5. orders header — discount_total ─────────────────────────────────────
  pgm.sql(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS discount_total NUMERIC(14,2) NOT NULL DEFAULT 0;
  `);

  // ── 6. Seed default discount config keys ──────────────────────────────────
  pgm.sql(`
    INSERT INTO system_config (key, value, updated_by)
    VALUES
      ('default_discount_type',           '"Normal"',     1),
      ('default_discount_mode',           '"Percentage"', 1),
      ('default_discount_value',          '0',             1),
      ('default_discount_mode_normal',    '"Percentage"', 1),
      ('default_discount_value_normal',   '0',             1),
      ('default_discount_mode_merchant',  '"Percentage"', 1),
      ('default_discount_value_merchant', '0',             1),
      ('default_discount_mode_special',   '"Percentage"', 1),
      ('default_discount_value_special',  '0',             1)
    ON CONFLICT (key) DO NOTHING;
  `);
};

exports.down = function (pgm) {
  // Remove seeded config keys
  pgm.sql(`
    DELETE FROM system_config
    WHERE key IN (
      'default_discount_type',
      'default_discount_mode',
      'default_discount_value',
      'default_discount_mode_normal',
      'default_discount_value_normal',
      'default_discount_mode_merchant',
      'default_discount_value_merchant',
      'default_discount_mode_special',
      'default_discount_value_special'
    );
  `);

  // Remove orders header column
  pgm.sql(`
    ALTER TABLE orders DROP COLUMN IF EXISTS discount_total;
  `);

  // Remove exchange_outgoing_items columns
  pgm.sql(`
    ALTER TABLE exchange_outgoing_items
      DROP COLUMN IF EXISTS discount_mode,
      DROP COLUMN IF EXISTS discount_type,
      DROP COLUMN IF EXISTS discount_amount,
      DROP COLUMN IF EXISTS discount_pct;
  `);

  // Remove return_line_items columns
  pgm.sql(`
    ALTER TABLE return_line_items
      DROP COLUMN IF EXISTS discount_mode,
      DROP COLUMN IF EXISTS discount_type;
  `);

  // Remove order_line_items columns
  pgm.sql(`
    ALTER TABLE order_line_items
      DROP COLUMN IF EXISTS discount_mode,
      DROP COLUMN IF EXISTS discount_type,
      DROP COLUMN IF EXISTS discount_pct;
  `);

  // Remove transaction_line_items columns
  pgm.sql(`
    ALTER TABLE transaction_line_items
      DROP COLUMN IF EXISTS discount_mode,
      DROP COLUMN IF EXISTS discount_type;
  `);
};
