'use strict';

// Purchase orders (#21 procurement part 1).
//
// 1. Currency (owner decision 6a). Order amounts feed stock costs and
// supplier balances, which are kept in ETB, so an order is in ETB. The column
// defaulted to USD, so orders created through the API without a currency
// were labelled USD while their amounts were used as ETB everywhere; their
// label becomes ETB. Buying in a foreign currency, with exchange rates, is a
// separate feature.
//
// 2. Every order names its receiving branch. New orders left it empty when
// the ordering branch received them; it becomes that branch, so "who may
// receive" (owner decision 1a, #66) reads one column. The API now always
// sets it; reads still take an empty one as the ordering branch.
//
// 3. Closing short (owner decision 3a): a part-received order can be closed
// when the supplier will not deliver the rest. The order keeps who closed it,
// when and why.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    UPDATE purchase_orders SET currency = 'ETB' WHERE currency <> 'ETB';
    ALTER TABLE purchase_orders
      ALTER COLUMN currency SET DEFAULT 'ETB',
      ADD CONSTRAINT purchase_orders_currency_etb CHECK (currency = 'ETB');

    UPDATE purchase_orders SET receiving_branch_id = branch_id WHERE receiving_branch_id IS NULL;

    ALTER TABLE purchase_orders
      ADD COLUMN closed_reason TEXT,
      ADD COLUMN closed_by     INTEGER REFERENCES staff(id),
      ADD COLUMN closed_at     TIMESTAMPTZ;
  `);
};

// The earlier currency labels are not restored: they were wrong.
exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE purchase_orders
      DROP COLUMN closed_at,
      DROP COLUMN closed_by,
      DROP COLUMN closed_reason;

    ALTER TABLE purchase_orders
      DROP CONSTRAINT purchase_orders_currency_etb,
      ALTER COLUMN currency SET DEFAULT 'USD';
  `);
};
