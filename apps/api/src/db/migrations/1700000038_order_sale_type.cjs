'use strict';

// Order Payment Unification — sale_type + order_credit_sale receivable
//
// 1. Adds sale_type column to orders: 'cash_sale' (default) | 'credit_sale'
//    Existing orders default to 'cash_sale' which preserves backward compatibility.
//
// 2. Extends the receivables.source_type CHECK constraint to include
//    'order_credit_sale' so that receivables can be created for confirmed
//    orders that are unpaid or partially paid.

exports.shorthands = undefined;

exports.up = function (pgm) {
  // ── 1. Add sale_type to orders ─────────────────────────────────────────────
  pgm.sql(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS sale_type TEXT NOT NULL DEFAULT 'cash_sale'
        CHECK (sale_type IN ('cash_sale', 'credit_sale'));
  `);

  // ── 2. Extend receivables.source_type CHECK constraint ─────────────────────
  pgm.sql(`
    ALTER TABLE receivables
      DROP CONSTRAINT IF EXISTS receivables_source_type_check;
    ALTER TABLE receivables
      ADD CONSTRAINT receivables_source_type_check
        CHECK (source_type IN ('pos_credit_sale', 'exchange_difference', 'order_credit_sale'));
  `);

  // ── 3. Fix any existing negative inventory quantities ──────────────────────
  pgm.sql(`
    UPDATE inventory
       SET quantity    = 0,
           updated_at = now()
     WHERE quantity < 0;
  `);
};

exports.down = function (pgm) {
  // Revert receivables constraint
  pgm.sql(`
    ALTER TABLE receivables
      DROP CONSTRAINT IF EXISTS receivables_source_type_check;
    ALTER TABLE receivables
      ADD CONSTRAINT receivables_source_type_check
        CHECK (source_type IN ('pos_credit_sale', 'exchange_difference'));
  `);

  // Remove sale_type column
  pgm.sql(`
    ALTER TABLE orders
      DROP COLUMN IF EXISTS sale_type;
  `);
};
