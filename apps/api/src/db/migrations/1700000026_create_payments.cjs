'use strict';

// Slice 14 — Payment Management
// Creates order_payments and order_refunds tables.
// Payments belong to orders; order.payment_status is updated by the payments service.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE order_payments (
      id                    BIGSERIAL PRIMARY KEY,
      payment_reference     TEXT UNIQUE NOT NULL,
      order_id              BIGINT NOT NULL REFERENCES orders(id),
      amount                NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      currency              TEXT NOT NULL DEFAULT 'ETB',
      payment_method        TEXT NOT NULL CHECK (payment_method IN ('cash','bank','mobile','card','store_credit','loyalty_points','other')),
      status                TEXT NOT NULL DEFAULT 'success'
                              CHECK (status IN ('pending','success','failed','refunded','partially_refunded')),
      transaction_reference TEXT,
      notes                 TEXT,
      processed_by          INTEGER NOT NULL,
      processed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON order_payments (order_id);
    CREATE INDEX ON order_payments (status);
    CREATE INDEX ON order_payments (processed_at DESC);

    CREATE TABLE order_refunds (
      id             BIGSERIAL PRIMARY KEY,
      payment_id     BIGINT NOT NULL REFERENCES order_payments(id),
      order_id       BIGINT NOT NULL REFERENCES orders(id),
      refund_amount  NUMERIC(14,2) NOT NULL CHECK (refund_amount > 0),
      reason         TEXT NOT NULL,
      processed_by   INTEGER NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON order_refunds (payment_id);
    CREATE INDEX ON order_refunds (order_id);
  `);
};

exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS order_refunds;`);
  pgm.sql(`DROP TABLE IF EXISTS order_payments;`);
};
