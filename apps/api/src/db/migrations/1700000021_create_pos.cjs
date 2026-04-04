'use strict';

// Slice 11 — POS (Point of Sale Transactions)
// Creates transactions, transaction_line_items, and transaction_payments tables.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE transactions (
      id                 BIGSERIAL PRIMARY KEY,
      branch_id          INTEGER NOT NULL REFERENCES branches(id),
      location_id        INTEGER NOT NULL REFERENCES locations(id),
      customer_id        INTEGER REFERENCES customers(id),
      staff_id           INTEGER NOT NULL,
      transaction_number TEXT UNIQUE NOT NULL,
      subtotal           NUMERIC(14,2) NOT NULL,
      discount_total     NUMERIC(14,2) NOT NULL DEFAULT 0,
      tax_total          NUMERIC(14,2) NOT NULL DEFAULT 0,
      grand_total        NUMERIC(14,2) NOT NULL,
      currency           TEXT NOT NULL DEFAULT 'ETB',
      status             TEXT NOT NULL DEFAULT 'completed'
                           CHECK (status IN ('completed','voided')),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON transactions (branch_id, status);
    CREATE INDEX ON transactions (customer_id) WHERE customer_id IS NOT NULL;
    CREATE INDEX ON transactions (created_at DESC);

    CREATE TABLE transaction_line_items (
      id              BIGSERIAL PRIMARY KEY,
      transaction_id  BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      book_id         INTEGER NOT NULL,
      quantity        INTEGER NOT NULL CHECK (quantity > 0),
      unit_price      NUMERIC(14,2) NOT NULL,
      discount_pct    NUMERIC(5,2) NOT NULL DEFAULT 0,
      discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      line_total      NUMERIC(14,2) NOT NULL
    );
    CREATE INDEX ON transaction_line_items (transaction_id);

    CREATE TABLE transaction_payments (
      id             BIGSERIAL PRIMARY KEY,
      transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      method         TEXT NOT NULL CHECK (method IN ('cash','bank','store_credit','loyalty_points')),
      amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      reference      TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON transaction_payments (transaction_id);
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS transaction_payments;
    DROP TABLE IF EXISTS transaction_line_items;
    DROP TABLE IF EXISTS transactions;
  `);
};
