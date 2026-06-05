'use strict';

// Receivable Settlement Management
// Creates a unified receivables table as the single source of truth
// for all customer debt tracking (Credit POS Sales + Exchange Differences).
// This migration is fully additive — no existing tables are modified.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE receivables (
      id                 BIGSERIAL PRIMARY KEY,
      source_type        TEXT NOT NULL
                           CHECK (source_type IN ('pos_credit_sale', 'exchange_difference')),
      source_ref_id      TEXT NOT NULL,
      source_entity_id   BIGINT NOT NULL,
      customer_id        INTEGER NOT NULL REFERENCES customers(id),
      branch_id          INTEGER NOT NULL REFERENCES branches(id),
      original_amount    NUMERIC(14,2) NOT NULL CHECK (original_amount > 0),
      outstanding_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (outstanding_amount >= 0),
      currency           TEXT NOT NULL DEFAULT 'ETB',
      due_date           DATE,
      settlement_date    TIMESTAMPTZ,
      status             TEXT NOT NULL DEFAULT 'Pending'
                           CHECK (status IN ('Pending', 'PartiallyPaid', 'Settled', 'Overdue')),
      notes              TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT receivables_source_unique UNIQUE (source_type, source_entity_id)
    );

    -- Index for customer lookups
    CREATE INDEX ON receivables (customer_id);

    -- Index for branch + status filtering (most common query)
    CREATE INDEX ON receivables (branch_id, status);

    -- Index for overdue job (only scans non-settled rows with a due date)
    CREATE INDEX ON receivables (due_date)
      WHERE due_date IS NOT NULL AND status IN ('Pending', 'PartiallyPaid');

    -- Index for source lookups (used by payment hooks)
    CREATE INDEX ON receivables (source_type, source_entity_id);

    -- Index for chronological listing
    CREATE INDEX ON receivables (created_at DESC);
  `);
};

exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS receivables;`);
};
