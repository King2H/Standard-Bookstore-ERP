'use strict';

// Opening balances (#246 part 3, owner decisions 2a and 1a–3a, 2026-11-07).
//
// A shop starting on the system brings the balances it carries:
// 1. What a customer owes: one opening receivable per customer
//    (source_type opening_balance, its source the customer), collected like an
//    exchange difference, by the receivable itself.
// 2. What the shop owes a supplier: one opening-balance purchase order per
//    supplier (kind opening_balance, OPB-), received, with no book lines; its
//    total is what is owed, paid, credited and reversed through the supplier
//    payments as any order. It is never a purchase.
// Store credit and loyalty points come in on their own histories, marked
// opening_balance. No existing row changes.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE receivables DROP CONSTRAINT receivables_source_type_check;
    ALTER TABLE receivables ADD CONSTRAINT receivables_source_type_check
      CHECK (source_type IN ('pos_credit_sale', 'exchange_difference', 'order_credit_sale', 'opening_balance'));

    ALTER TABLE purchase_orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'order'
      CONSTRAINT purchase_orders_kind_check CHECK (kind IN ('order', 'opening_balance'));
    -- One opening balance per supplier.
    CREATE UNIQUE INDEX purchase_orders_opening_balance_once ON purchase_orders (tenant_id, supplier_id) WHERE kind = 'opening_balance';
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DROP INDEX purchase_orders_opening_balance_once;
    ALTER TABLE purchase_orders DROP COLUMN kind;
    ALTER TABLE receivables DROP CONSTRAINT receivables_source_type_check;
    ALTER TABLE receivables ADD CONSTRAINT receivables_source_type_check
      CHECK (source_type IN ('pos_credit_sale', 'exchange_difference', 'order_credit_sale'));
  `);
};
