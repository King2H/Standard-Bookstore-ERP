'use strict';

// Bank and Telebirr payments carry their proof (owner decisions 1a, 2a, 3a,
// 2026-10-18): a bank transfer names the customer's bank and its reference,
// a Telebirr payment its transaction number.
//
// - payer_bank: the bank the customer paid from, on every table that records
//   customer money coming in at the counter (POS payments, order payments,
//   exchange settlement entries). Receivable collections keep it in the
//   ledger entry's meta, with the reference.
// - exchange_settlement_entries.reference: an exchange payment's reference
//   was written to `note`, which nothing reads; it moves to its own column.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE transaction_payments ADD COLUMN payer_bank text;
    ALTER TABLE order_payments ADD COLUMN payer_bank text;
    ALTER TABLE exchange_settlement_entries ADD COLUMN payer_bank text;
    ALTER TABLE exchange_settlement_entries ADD COLUMN reference text;

    UPDATE exchange_settlement_entries
       SET reference = note, note = NULL
     WHERE entry_type = 'cash_payment' AND note IS NOT NULL;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    UPDATE exchange_settlement_entries
       SET note = reference
     WHERE entry_type = 'cash_payment' AND reference IS NOT NULL;

    ALTER TABLE exchange_settlement_entries DROP COLUMN reference;
    ALTER TABLE exchange_settlement_entries DROP COLUMN payer_bank;
    ALTER TABLE order_payments DROP COLUMN payer_bank;
    ALTER TABLE transaction_payments DROP COLUMN payer_bank;
  `);
};
