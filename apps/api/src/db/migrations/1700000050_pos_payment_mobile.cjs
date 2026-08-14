'use strict';

// Unify Payment Methods — add Telebirr (mobile) to POS
//
// transaction_payments.method (POS sales + POS credit-sale collection) was
// the one payment surface in the app whose CHECK constraint never included
// 'mobile' — order_payments and financial_transactions (Orders, Payment
// Collection, Exchange settlement) already accept it. Non-destructive:
// widens the existing constraint only, no column/data changes. Every
// existing 'cash'/'bank'/'store_credit'/'loyalty_points' row keeps working.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE transaction_payments
      DROP CONSTRAINT IF EXISTS transaction_payments_method_check;
    ALTER TABLE transaction_payments
      ADD CONSTRAINT transaction_payments_method_check
      CHECK (method IN ('cash', 'bank', 'mobile', 'store_credit', 'loyalty_points'));
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE transaction_payments
      DROP CONSTRAINT IF EXISTS transaction_payments_method_check;
    ALTER TABLE transaction_payments
      ADD CONSTRAINT transaction_payments_method_check
      CHECK (method IN ('cash', 'bank', 'store_credit', 'loyalty_points'));
  `);
};
