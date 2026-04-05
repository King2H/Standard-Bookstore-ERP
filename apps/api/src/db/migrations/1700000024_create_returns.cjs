'use strict';

// Slice 12 — Returns & Refunds
// Creates returns, return_line_items, and refunds tables.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE returns (
      id                  BIGSERIAL PRIMARY KEY,
      return_number       TEXT UNIQUE NOT NULL,
      transaction_id      BIGINT NOT NULL REFERENCES transactions(id),
      branch_id           INTEGER NOT NULL REFERENCES branches(id),
      customer_id         INTEGER REFERENCES customers(id),
      total_refund_amount NUMERIC(14,2) NOT NULL,
      refund_method       TEXT NOT NULL CHECK (refund_method IN ('cash','store_credit')),
      status              TEXT NOT NULL DEFAULT 'completed'
                            CHECK (status IN ('completed','rejected')),
      reason              TEXT,
      processed_by        INTEGER NOT NULL,
      approved_by         INTEGER,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON returns (transaction_id);
    CREATE INDEX ON returns (branch_id, created_at DESC);
    CREATE INDEX ON returns (customer_id) WHERE customer_id IS NOT NULL;

    CREATE TABLE return_line_items (
      id                      BIGSERIAL PRIMARY KEY,
      return_id               BIGINT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
      transaction_line_item_id BIGINT NOT NULL,
      book_id                 INTEGER NOT NULL,
      quantity                INTEGER NOT NULL CHECK (quantity > 0),
      unit_price              NUMERIC(14,2) NOT NULL,
      line_refund_amount      NUMERIC(14,2) NOT NULL
    );
    CREATE INDEX ON return_line_items (return_id);

    CREATE TABLE refunds (
      id         BIGSERIAL PRIMARY KEY,
      return_id  BIGINT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
      method     TEXT NOT NULL CHECK (method IN ('cash','store_credit')),
      amount     NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON refunds (return_id);
  `);

  // Extend inventory_history reference_type to include 'pos_return'
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order','return','adjustment','manual','initial_stock','sale','void','pos_return'
      ));
  `);
};

exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS refunds;`);
  pgm.sql(`DROP TABLE IF EXISTS return_line_items;`);
  pgm.sql(`DROP TABLE IF EXISTS returns;`);
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order','return','adjustment','manual','initial_stock','sale','void'
      ));
  `);
};
