'use strict';

// Returns (#21, owner decisions 1a and 2a).
//
// A return against a credit sale is first set against what the customer
// still owes on that sale: a credit note, booked as a refund with method
// 'credit_note'. What was paid comes back the way it was paid, so a refund
// may now go back as bank, mobile or loyalty points too, and a return whose
// money went back more than one way says 'mixed'. The receivable keeps the
// credit notes set against it, so reports do not count them as collected.
//
// Return numbers (RET-YYYYMMDD-NNNN) came from a count of the day's returns,
// so two at the same moment got the same number (owner decision 5a, #68).
// They now come from the RET document counter, which starts from the numbers
// already issued.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE refunds
      DROP CONSTRAINT refunds_method_check,
      ADD CONSTRAINT refunds_method_check
        CHECK (method IN ('cash', 'bank', 'mobile', 'store_credit', 'loyalty_points', 'credit_note'));

    ALTER TABLE returns
      DROP CONSTRAINT returns_refund_method_check,
      ADD CONSTRAINT returns_refund_method_check
        CHECK (refund_method IN ('cash', 'bank', 'mobile', 'store_credit', 'loyalty_points', 'credit_note', 'mixed'));

    ALTER TABLE receivables ADD COLUMN credited_amount NUMERIC(14,2) NOT NULL DEFAULT 0;

    INSERT INTO document_counters (series, period, last_value)
    SELECT 'RET', substring(return_number FROM 5 FOR 8), MAX(substring(return_number FROM 14)::int)
    FROM returns
    WHERE return_number ~ '^RET-[0-9]{8}-[0-9]+$'
    GROUP BY 2
    ON CONFLICT (series, period) DO UPDATE SET last_value = GREATEST(document_counters.last_value, EXCLUDED.last_value);
  `);
};

// Refunds that went back another way than cash or store credit are recorded
// as cash, the closest of the two old methods.
exports.down = function (pgm) {
  pgm.sql(`
    DELETE FROM document_counters WHERE series = 'RET';
    ALTER TABLE receivables DROP COLUMN credited_amount;

    UPDATE returns SET refund_method = 'cash' WHERE refund_method NOT IN ('cash', 'store_credit');
    ALTER TABLE returns
      DROP CONSTRAINT returns_refund_method_check,
      ADD CONSTRAINT returns_refund_method_check CHECK (refund_method IN ('cash', 'store_credit'));

    UPDATE refunds SET method = 'cash' WHERE method NOT IN ('cash', 'store_credit');
    ALTER TABLE refunds
      DROP CONSTRAINT refunds_method_check,
      ADD CONSTRAINT refunds_method_check CHECK (method IN ('cash', 'store_credit'));
  `);
};
