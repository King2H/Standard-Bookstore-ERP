'use strict';

// Supplier payables (#21 procurement part 2).
//
// 1. Reversing a payment (owner decision 1a). A supplier payment recorded by
// mistake is reversed, never deleted: it keeps who reversed it, when and why,
// and stops counting towards what was paid.
//
// 2. Document numbers (owner decision 2a). Supplier payments and credit notes
// had none; screens and the ledger showed database ids. They are numbered
// from the daily document counter like every other document:
// SPAY-YYYYMMDD-NNNN and SCN-YYYYMMDD-NNNN. Existing ones are numbered by
// their day, in the order they were made, and the counters start after them.
//
// 3. Payment methods (owner decision 3a): cash, bank, mobile or cheque, the
// codes the rest of the system uses. The web form sent bank_transfer, which
// becomes bank. The check is NOT VALID so any other old value is kept as it
// was recorded; new payments must use one of the four.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE supplier_payments
      ADD COLUMN payment_number  TEXT UNIQUE,
      ADD COLUMN reversed_at     TIMESTAMPTZ,
      ADD COLUMN reversed_by     INTEGER REFERENCES staff(id),
      ADD COLUMN reversal_reason TEXT,
      ADD CONSTRAINT supplier_payments_reversal_recorded
        CHECK (reversed_at IS NULL OR (reversed_by IS NOT NULL AND reversal_reason IS NOT NULL));

    UPDATE supplier_payments SET payment_method = 'bank' WHERE payment_method = 'bank_transfer';
    ALTER TABLE supplier_payments
      ADD CONSTRAINT supplier_payments_method_check
        CHECK (payment_method IN ('cash', 'bank', 'mobile', 'cheque')) NOT VALID;

    ALTER TABLE supplier_credit_notes ADD COLUMN credit_note_number TEXT UNIQUE;

    WITH numbered AS (
      SELECT id, TO_CHAR(created_at, 'YYYYMMDD') AS period,
             ROW_NUMBER() OVER (PARTITION BY TO_CHAR(created_at, 'YYYYMMDD') ORDER BY created_at, id) AS n
      FROM supplier_payments
    )
    UPDATE supplier_payments sp
       SET payment_number = 'SPAY-' || numbered.period || '-' || LPAD(numbered.n::text, 4, '0')
      FROM numbered
     WHERE numbered.id = sp.id;

    WITH numbered AS (
      SELECT id, TO_CHAR(created_at, 'YYYYMMDD') AS period,
             ROW_NUMBER() OVER (PARTITION BY TO_CHAR(created_at, 'YYYYMMDD') ORDER BY created_at, id) AS n
      FROM supplier_credit_notes
    )
    UPDATE supplier_credit_notes cn
       SET credit_note_number = 'SCN-' || numbered.period || '-' || LPAD(numbered.n::text, 4, '0')
      FROM numbered
     WHERE numbered.id = cn.id;

    INSERT INTO document_counters (series, period, last_value)
    SELECT 'SPAY', TO_CHAR(created_at, 'YYYYMMDD'), COUNT(*) FROM supplier_payments GROUP BY 2
    ON CONFLICT (series, period) DO UPDATE SET last_value = GREATEST(document_counters.last_value, EXCLUDED.last_value);

    INSERT INTO document_counters (series, period, last_value)
    SELECT 'SCN', TO_CHAR(created_at, 'YYYYMMDD'), COUNT(*) FROM supplier_credit_notes GROUP BY 2
    ON CONFLICT (series, period) DO UPDATE SET last_value = GREATEST(document_counters.last_value, EXCLUDED.last_value);
  `);
};

// Reversed payments come back as ordinary payments: reversing one is not
// possible before this migration. bank stays bank.
exports.down = function (pgm) {
  pgm.sql(`
    DELETE FROM document_counters WHERE series IN ('SPAY', 'SCN');
    ALTER TABLE supplier_credit_notes DROP COLUMN credit_note_number;
    ALTER TABLE supplier_payments
      DROP CONSTRAINT supplier_payments_method_check,
      DROP CONSTRAINT supplier_payments_reversal_recorded,
      DROP COLUMN reversal_reason,
      DROP COLUMN reversed_by,
      DROP COLUMN reversed_at,
      DROP COLUMN payment_number;
  `);
};
