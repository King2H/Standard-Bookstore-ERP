'use strict';

// Binding on an exchange's outgoing books (#169 PR 4, owner decisions 1a, 5a, 2026-10-26).
//
// A service line belongs to one book line: of a counter sale, an order, or now
// the books an exchange gives out (1a), so its job, the board and the reports
// are the same for all three. A binding cancelled on an exchange gives its fee
// back as a return of the fee (5a): a return now names a counter sale, an
// order or an exchange.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE sale_service_lines
      ADD COLUMN exchange_outgoing_item_id bigint REFERENCES exchange_outgoing_items(id) ON DELETE CASCADE;
    ALTER TABLE sale_service_lines DROP CONSTRAINT sale_service_lines_one_sale;
    ALTER TABLE sale_service_lines ADD CONSTRAINT sale_service_lines_one_sale
      CHECK (num_nonnulls(transaction_line_item_id, order_line_item_id, exchange_outgoing_item_id) = 1);
    CREATE UNIQUE INDEX sale_service_lines_exchange_line ON sale_service_lines (exchange_outgoing_item_id)
      WHERE exchange_outgoing_item_id IS NOT NULL;

    ALTER TABLE returns ADD COLUMN exchange_id bigint REFERENCES exchanges(id);
    ALTER TABLE returns DROP CONSTRAINT returns_one_sale;
    ALTER TABLE returns ADD CONSTRAINT returns_one_sale CHECK (num_nonnulls(transaction_id, order_id, exchange_id) = 1);
    CREATE INDEX returns_exchange_id_idx ON returns (exchange_id) WHERE exchange_id IS NOT NULL;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS returns_exchange_id_idx;
    ALTER TABLE returns DROP CONSTRAINT returns_one_sale;
    ALTER TABLE returns ADD CONSTRAINT returns_one_sale CHECK (num_nonnulls(transaction_id, order_id) = 1);
    ALTER TABLE returns DROP COLUMN exchange_id;

    DROP INDEX IF EXISTS sale_service_lines_exchange_line;
    ALTER TABLE sale_service_lines DROP CONSTRAINT sale_service_lines_one_sale;
    ALTER TABLE sale_service_lines ADD CONSTRAINT sale_service_lines_one_sale
      CHECK (num_nonnulls(transaction_line_item_id, order_line_item_id) = 1);
    ALTER TABLE sale_service_lines DROP COLUMN exchange_outgoing_item_id;
  `);
};
