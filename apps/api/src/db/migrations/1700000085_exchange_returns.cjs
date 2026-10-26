'use strict';

// A defective bound copy from an exchange comes back through Returns (#203,
// owner decision 1a, 2026-10-26): a return line names a counter sale's line,
// an order's, or now a book an exchange gave out.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE return_line_items ADD COLUMN exchange_outgoing_item_id bigint REFERENCES exchange_outgoing_items(id);
    ALTER TABLE return_line_items DROP CONSTRAINT return_line_items_one_line;
    ALTER TABLE return_line_items ADD CONSTRAINT return_line_items_one_line
      CHECK (num_nonnulls(transaction_line_item_id, order_line_item_id, exchange_outgoing_item_id) = 1);
    CREATE INDEX return_line_items_exchange_line_idx ON return_line_items (exchange_outgoing_item_id)
      WHERE exchange_outgoing_item_id IS NOT NULL;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS return_line_items_exchange_line_idx;
    ALTER TABLE return_line_items DROP CONSTRAINT return_line_items_one_line;
    ALTER TABLE return_line_items ADD CONSTRAINT return_line_items_one_line
      CHECK (num_nonnulls(transaction_line_item_id, order_line_item_id) = 1);
    ALTER TABLE return_line_items DROP COLUMN exchange_outgoing_item_id;
  `);
};
