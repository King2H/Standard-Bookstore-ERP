'use strict';

// Post-MVP Hardening Migration
// 1. Idempotency keys table (P1)
// 2. Outbox table foundation (P5)
// 3. Customer PII encryption columns (P2)
// 4. Installment plans + installments (P3)
// 5. Merchant foundation — nullable merchant_id on exchanges (P4)
// 6. bank_account_id on order_payments and order_refunds (P1)

exports.shorthands = undefined;

exports.up = function (pgm) {

  // ── 1. Idempotency keys ────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE idempotency_keys (
      key              TEXT        PRIMARY KEY,
      endpoint         TEXT        NOT NULL,
      request_hash     TEXT        NOT NULL,
      response_payload JSONB       NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours'
    );
    CREATE INDEX ON idempotency_keys (expires_at);
  `);

  // ── 2. Outbox table (foundation — no workers yet) ─────────────────────────
  pgm.sql(`
    CREATE TABLE outbox (
      id           BIGSERIAL PRIMARY KEY,
      event_type   TEXT        NOT NULL,
      payload      JSONB       NOT NULL,
      status       TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','published','failed')),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ
    );
    CREATE INDEX ON outbox (status, created_at);
  `);

  // ── 3. Customer PII encryption columns ────────────────────────────────────
  // Add encrypted columns alongside existing plaintext columns.
  // Existing data stays in plaintext columns; new writes go to encrypted columns.
  // email_lookup and phone_lookup store SHA256 hash for search.
  pgm.sql(`
    ALTER TABLE customers
      ADD COLUMN IF NOT EXISTS email_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS phone_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS email_lookup    TEXT,
      ADD COLUMN IF NOT EXISTS phone_lookup    TEXT;

    CREATE INDEX IF NOT EXISTS customers_email_lookup_idx ON customers (email_lookup);
    CREATE INDEX IF NOT EXISTS customers_phone_lookup_idx ON customers (phone_lookup);
  `);

  // ── 4. Installment plans + installments ───────────────────────────────────
  pgm.sql(`
    CREATE TABLE installment_plans (
      id              BIGSERIAL PRIMARY KEY,
      order_id        BIGINT    NOT NULL REFERENCES orders(id),
      total_amount    NUMERIC(14,2) NOT NULL CHECK (total_amount > 0),
      deposit_amount  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
      num_installments INTEGER  NOT NULL CHECK (num_installments >= 1),
      currency        TEXT      NOT NULL DEFAULT 'ETB',
      notes           TEXT,
      created_by      INTEGER   NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON installment_plans (order_id);

    CREATE TABLE installments (
      id           BIGSERIAL PRIMARY KEY,
      plan_id      BIGINT    NOT NULL REFERENCES installment_plans(id),
      order_id     BIGINT    NOT NULL REFERENCES orders(id),
      due_date     DATE      NOT NULL,
      amount       NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      paid_amount  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
      status       TEXT      NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','partial','paid','overdue')),
      paid_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON installments (plan_id);
    CREATE INDEX ON installments (order_id);
    CREATE INDEX ON installments (status, due_date);
  `);

  // ── 5. Merchant foundation — nullable merchant_id on exchanges ─────────────
  pgm.sql(`
    CREATE TABLE merchants (
      id           SERIAL  PRIMARY KEY,
      name         TEXT    UNIQUE NOT NULL,
      contact_info JSONB   NOT NULL DEFAULT '{}',
      address      TEXT,
      is_active    BOOLEAN NOT NULL DEFAULT true,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE exchanges
      ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES merchants(id);

    CREATE INDEX IF NOT EXISTS exchanges_merchant_id_idx ON exchanges (merchant_id) WHERE merchant_id IS NOT NULL;
  `);

  // ── 6. bank_account_id on order_payments and order_refunds ────────────────
  pgm.sql(`
    ALTER TABLE order_payments
      ADD COLUMN IF NOT EXISTS bank_account_id INTEGER REFERENCES bank_accounts(id);

    ALTER TABLE order_refunds
      ADD COLUMN IF NOT EXISTS bank_account_id INTEGER REFERENCES bank_accounts(id);
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE order_refunds  DROP COLUMN IF EXISTS bank_account_id;
    ALTER TABLE order_payments DROP COLUMN IF EXISTS bank_account_id;
    DROP INDEX IF EXISTS exchanges_merchant_id_idx;
    ALTER TABLE exchanges DROP COLUMN IF EXISTS merchant_id;
    DROP TABLE IF EXISTS merchants;
    DROP TABLE IF EXISTS installments;
    DROP TABLE IF EXISTS installment_plans;
    DROP INDEX IF EXISTS customers_phone_lookup_idx;
    DROP INDEX IF EXISTS customers_email_lookup_idx;
    ALTER TABLE customers
      DROP COLUMN IF EXISTS phone_lookup,
      DROP COLUMN IF EXISTS email_lookup,
      DROP COLUMN IF EXISTS phone_encrypted,
      DROP COLUMN IF EXISTS email_encrypted;
    DROP TABLE IF EXISTS outbox;
    DROP TABLE IF EXISTS idempotency_keys;
  `);
};
