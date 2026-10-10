'use strict';

// Payments (#21, part 1).
//
// 1. Document number series (owner decision 4a; part of #68).
// Payment numbers (PAY-YYYYMMDD-NNNN) came from a count of the day's
// payments, so two recorded at the same moment got the same number and one
// failed on the unique index. Each series now has one counter row per day,
// taken with INSERT ... ON CONFLICT DO UPDATE, which locks it until the
// transaction ends. The counters start from the numbers already issued.
//
// 2. A refund goes back the way the payment was made (owner decision 2a), so
// it records that method. Refunds made before keep none: nothing recorded it.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE document_counters (
      series     TEXT    NOT NULL,
      period     TEXT    NOT NULL,
      last_value INTEGER NOT NULL CHECK (last_value > 0),
      PRIMARY KEY (series, period)
    );

    INSERT INTO document_counters (series, period, last_value)
    SELECT 'PAY', substring(payment_reference FROM 5 FOR 8), MAX(substring(payment_reference FROM 14)::int)
    FROM order_payments
    WHERE payment_reference ~ '^PAY-[0-9]{8}-[0-9]+$'
    GROUP BY 2;

    ALTER TABLE order_refunds ADD COLUMN method TEXT;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE order_refunds DROP COLUMN method;
    DROP TABLE document_counters;
  `);
};
