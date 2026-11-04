'use strict';

// Cash handed over at the till (#226, owner decision 3a, 2026-11-04).
//
// A cash payment records what was due; the cash the customer handed over is
// kept next to it, so a receipt shows the cash given and the change from what
// was recorded. Only cash is handed over, and never less than the payment.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE transaction_payments ADD COLUMN cash_tendered numeric(14,2);
    ALTER TABLE transaction_payments ADD CONSTRAINT transaction_payments_cash_tendered
      CHECK (cash_tendered IS NULL OR (method = 'cash' AND cash_tendered >= amount));
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE transaction_payments DROP CONSTRAINT IF EXISTS transaction_payments_cash_tendered;
    ALTER TABLE transaction_payments DROP COLUMN cash_tendered;
  `);
};
