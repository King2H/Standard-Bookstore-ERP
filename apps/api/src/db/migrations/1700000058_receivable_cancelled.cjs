'use strict';

// A receivable whose sale was cancelled (#21 POS, owner decision 2a): the
// debt is gone, but it was neither paid (Settled) nor written off. The
// receivable keeps how much was still owed when the sale was cancelled, so
// "collected = original − outstanding − written off − cancelled" stays true
// in every report.
//
// Order cancellation used to mark the receivable Settled, so a cancelled
// order's debt read as money collected. Those receivables become Cancelled,
// with what the order still owed (total less what was paid, net of refunds).
// One whose order had been paid in full keeps Settled: nothing was owed.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE receivables
      DROP CONSTRAINT receivables_status_check,
      ADD CONSTRAINT receivables_status_check
        CHECK (status IN ('Pending', 'PartiallyPaid', 'Settled', 'Overdue', 'WrittenOff', 'Cancelled')),
      ADD COLUMN cancelled_amount NUMERIC(14,2),
      ADD COLUMN cancelled_at     TIMESTAMPTZ,
      ADD CONSTRAINT receivables_cancel_recorded
        CHECK (status <> 'Cancelled' OR (cancelled_amount > 0 AND cancelled_at IS NOT NULL));

    WITH owed AS (
      SELECT r.id,
             LEAST(r.original_amount, GREATEST(0, o.total
               - COALESCE((SELECT SUM(amount) FROM order_payments
                           WHERE order_id = o.id AND status IN ('success', 'partially_refunded', 'refunded')), 0)
               + COALESCE((SELECT SUM(refund_amount) FROM order_refunds WHERE order_id = o.id), 0))) AS amount,
             o.updated_at
      FROM receivables r
      JOIN orders o ON o.id = r.source_entity_id
      WHERE r.source_type = 'order_credit_sale' AND r.status = 'Settled' AND upper(o.status) = 'CANCELLED'
    )
    UPDATE receivables r
       SET status = 'Cancelled', cancelled_amount = owed.amount, cancelled_at = owed.updated_at, settlement_date = NULL
      FROM owed
     WHERE owed.id = r.id AND owed.amount > 0;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    UPDATE receivables SET status = 'Settled', settlement_date = cancelled_at WHERE status = 'Cancelled';
    ALTER TABLE receivables
      DROP CONSTRAINT receivables_cancel_recorded,
      DROP COLUMN cancelled_amount,
      DROP COLUMN cancelled_at,
      DROP CONSTRAINT receivables_status_check,
      ADD CONSTRAINT receivables_status_check
        CHECK (status IN ('Pending', 'PartiallyPaid', 'Settled', 'Overdue', 'WrittenOff'));
  `);
};
