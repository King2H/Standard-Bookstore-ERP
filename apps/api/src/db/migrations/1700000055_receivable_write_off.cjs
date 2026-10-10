'use strict';

// Receivable write-off (#21, owner decision): writing off a bad debt gets its
// own status, WrittenOff, distinct from Settled (paid). The receivable keeps
// how much was written off, when, by whom and why, and the ledger gets a
// write_off entry. A POS credit sale has neither an order nor an exchange, so
// a ledger entry may now name the receivable instead.
//
// Receivables "settled" by the old write-off before this migration stay
// Settled: nothing recorded how much was still owed when they were closed.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE receivables
      DROP CONSTRAINT receivables_status_check,
      ADD CONSTRAINT receivables_status_check
        CHECK (status IN ('Pending', 'PartiallyPaid', 'Settled', 'Overdue', 'WrittenOff')),
      ADD COLUMN written_off_amount NUMERIC(14,2),
      ADD COLUMN written_off_at     TIMESTAMPTZ,
      ADD COLUMN written_off_by     INTEGER REFERENCES staff(id),
      ADD COLUMN write_off_reason   TEXT,
      ADD CONSTRAINT receivables_write_off_recorded
        CHECK (status <> 'WrittenOff' OR (
          written_off_amount > 0 AND written_off_at IS NOT NULL
          AND written_off_by IS NOT NULL AND write_off_reason IS NOT NULL
        ));

    ALTER TABLE financial_transactions
      ADD COLUMN receivable_id BIGINT REFERENCES receivables(id),
      DROP CONSTRAINT financial_transactions_type_check,
      ADD CONSTRAINT financial_transactions_type_check
        CHECK (type IN ('payment', 'refund', 'adjustment', 'write_off')),
      DROP CONSTRAINT ft_must_reference_order_or_exchange,
      ADD CONSTRAINT ft_must_reference_order_or_exchange
        CHECK (order_id IS NOT NULL OR exchange_id IS NOT NULL OR receivable_id IS NOT NULL);

    CREATE INDEX idx_ft_receivable ON financial_transactions (receivable_id) WHERE receivable_id IS NOT NULL;
  `);
};

// A ledger entry that names only a receivable (a POS sale's write-off) has
// nowhere to go in the old schema, and deleting ledger entries is not a
// migration's call: the rollback stops and names them instead.
exports.down = async function (pgm) {
  const { rows } = await pgm.db.query(
    `SELECT id FROM financial_transactions WHERE order_id IS NULL AND exchange_id IS NULL ORDER BY id`,
  );
  if (rows.length > 0) {
    throw new Error(
      'Ledger entries that name only a receivable must be removed before rolling back: financial_transactions ' +
        rows.map((r) => r.id).join(', '),
    );
  }
  pgm.sql(`
    DROP INDEX idx_ft_receivable;
    UPDATE financial_transactions SET type = 'adjustment' WHERE type = 'write_off';
    ALTER TABLE financial_transactions
      DROP CONSTRAINT ft_must_reference_order_or_exchange,
      ADD CONSTRAINT ft_must_reference_order_or_exchange
        CHECK (order_id IS NOT NULL OR exchange_id IS NOT NULL),
      DROP CONSTRAINT financial_transactions_type_check,
      ADD CONSTRAINT financial_transactions_type_check
        CHECK (type IN ('payment', 'refund', 'adjustment')),
      DROP COLUMN receivable_id;

    UPDATE receivables SET status = 'Settled', settlement_date = written_off_at WHERE status = 'WrittenOff';
    ALTER TABLE receivables
      DROP CONSTRAINT receivables_write_off_recorded,
      DROP CONSTRAINT receivables_status_check,
      ADD CONSTRAINT receivables_status_check
        CHECK (status IN ('Pending', 'PartiallyPaid', 'Settled', 'Overdue')),
      DROP COLUMN written_off_amount,
      DROP COLUMN written_off_at,
      DROP COLUMN written_off_by,
      DROP COLUMN write_off_reason;
  `);
};
