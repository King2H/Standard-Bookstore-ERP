'use strict';

// Slice 11.x — POS Credit Sales
// Adds payment_status to transactions to track partial/credit payment state.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE transactions
      ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'paid'
        CHECK (payment_status IN ('paid', 'partial', 'credit')),
      ADD COLUMN amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN amount_due  NUMERIC(14,2) NOT NULL DEFAULT 0;
  `);

  pgm.sql(`
    UPDATE transactions
    SET payment_status = 'paid',
        amount_paid    = grand_total,
        amount_due     = 0;
  `);

  pgm.sql(`CREATE INDEX transactions_payment_status_idx ON transactions (payment_status) WHERE payment_status != 'paid';`);
};

exports.down = function (pgm) {
  pgm.sql(`DROP INDEX IF EXISTS transactions_payment_status_idx;`);
  pgm.sql(`
    ALTER TABLE transactions
      DROP COLUMN IF EXISTS payment_status,
      DROP COLUMN IF EXISTS amount_paid,
      DROP COLUMN IF EXISTS amount_due;
  `);
};
