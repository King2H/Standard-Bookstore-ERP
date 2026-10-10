'use strict';

// Exchanges (#21).
//
// 1. One exchange flow (owner decision 1a): Quick Exchange. The lifecycle
// flow (initiate, review, approve, settle) is retired; its rows stay
// readable. Quick Exchange takes over what only the lifecycle had: an
// incoming book can be damaged, kept apart from stock for sale.
//
// 2. When the store owes the difference (owner decision 3a) it goes back as
// store credit or cash; the exchange keeps which.
//
// 3. A same-day void (owner decision 5a) keeps who voided the exchange, when
// and why. A voided exchange is Cancelled, so reports that count completed
// exchanges leave it out.
//
// 4. Exchange numbers (EXC-YYYYMMDD-NNNN) came from a count of the day's
// exchanges, so two at the same moment got the same number (#68). They come
// from the EXC document counter, which starts after the numbers issued.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE exchange_incoming_items
      ADD COLUMN condition TEXT NOT NULL DEFAULT 'resellable'
        CONSTRAINT exchange_incoming_items_condition_check CHECK (condition IN ('resellable', 'damaged'));

    ALTER TABLE exchanges
      ADD COLUMN refund_method TEXT
        CONSTRAINT exchanges_refund_method_check CHECK (refund_method IN ('store_credit', 'cash')),
      ADD COLUMN voided_at   TIMESTAMPTZ,
      ADD COLUMN voided_by   INTEGER REFERENCES staff(id),
      ADD COLUMN void_reason TEXT,
      ADD CONSTRAINT exchanges_void_recorded
        CHECK (voided_at IS NULL OR (voided_by IS NOT NULL AND void_reason IS NOT NULL AND status = 'Cancelled'));

    -- Store refunds before this were all store credit.
    UPDATE exchanges SET refund_method = 'store_credit' WHERE settlement_type = 'Store_Refunds';

    INSERT INTO document_counters (series, period, last_value)
    SELECT 'EXC', substring(exchange_reference FROM 5 FOR 8), MAX(substring(exchange_reference FROM 14)::int)
    FROM exchanges
    WHERE exchange_reference ~ '^EXC-[0-9]{8}-[0-9]+$'
    GROUP BY 2
    ON CONFLICT (series, period) DO UPDATE SET last_value = GREATEST(document_counters.last_value, EXCLUDED.last_value);
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DELETE FROM document_counters WHERE series = 'EXC';
    ALTER TABLE exchanges
      DROP CONSTRAINT exchanges_void_recorded,
      DROP COLUMN void_reason,
      DROP COLUMN voided_by,
      DROP COLUMN voided_at,
      DROP COLUMN refund_method;
    ALTER TABLE exchange_incoming_items DROP COLUMN condition;
  `);
};
