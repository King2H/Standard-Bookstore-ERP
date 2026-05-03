'use strict';

// ERP Production Hardening Migration
// All changes are additive and backward-compatible.
//
// 1.1  Extend orders.status CHECK constraint (keep legacy + add new values)
// 1.2  Map existing order statuses to new values
// 1.3  Create inventory_reservations table with indexes
// 1.4  Add damaged_quantity column to inventory
// 1.5  Extend inventory_history.reference_type constraint
// 1.6  Add lifecycle_status, original_order_id, customer_id_v2 to exchanges
// 1.7  Map existing exchange statuses to new lifecycle_status values
// 1.8  Create exchange_items table (unified, additive)
// 1.9  Create exchange_settlement_entries table
// 1.10 Create financial_transactions table
// 1.11 Add is_all_branches column to staff
// 1.12 Ensure idempotency_keys table exists (already created in migration 28)

exports.shorthands = undefined;

exports.up = function (pgm) {

  // ── 1.1 Extend orders.status CHECK constraint ─────────────────────────────
  // Drop the existing constraint and re-add it with both legacy and new values.
  pgm.sql(`
    ALTER TABLE orders
      DROP CONSTRAINT IF EXISTS orders_status_check;
    ALTER TABLE orders
      ADD CONSTRAINT orders_status_check
      CHECK (status IN (
        'Pending','Confirmed','In_Progress','Fulfilled','Cancelled',
        'DRAFT','CONFIRMED','PAID','FULFILLED','COMPLETED','CANCELLED'
      ));
  `);

  // ── 1.2 Map existing order statuses to new values ─────────────────────────
  // Order matters: map FULFILLED first, then check for COMPLETED condition,
  // so that orders with payment_status='paid' AND status='Fulfilled' become COMPLETED.
  pgm.sql(`
    UPDATE orders SET status = 'DRAFT'      WHERE status = 'Pending';
    UPDATE orders SET status = 'CONFIRMED'  WHERE status IN ('Confirmed', 'In_Progress');
    UPDATE orders SET status = 'FULFILLED'  WHERE status = 'Fulfilled';
    UPDATE orders SET status = 'CANCELLED'  WHERE status = 'Cancelled';
    UPDATE orders SET status = 'COMPLETED'
      WHERE status = 'FULFILLED' AND payment_status = 'paid';
  `);

  // ── 1.3 Create inventory_reservations table ───────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS inventory_reservations (
      id          BIGSERIAL   PRIMARY KEY,
      order_id    BIGINT      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      book_id     INTEGER     NOT NULL REFERENCES books(id),
      location_id INTEGER     NOT NULL REFERENCES locations(id),
      quantity    INTEGER     NOT NULL CHECK (quantity > 0),
      status      TEXT        NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved', 'deducted', 'released')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_inv_res_order
      ON inventory_reservations (order_id);

    CREATE INDEX IF NOT EXISTS idx_inv_res_book_loc
      ON inventory_reservations (book_id, location_id)
      WHERE status = 'reserved';
  `);

  // ── 1.4 Add damaged_quantity column to inventory ──────────────────────────
  pgm.sql(`
    ALTER TABLE inventory
      ADD COLUMN IF NOT EXISTS damaged_quantity INTEGER NOT NULL DEFAULT 0;
  `);

  // ── 1.5 Extend inventory_history.reference_type constraint ────────────────
  // Current values (from migration 1700000027): purchase_order, return,
  // adjustment, manual, initial_stock, sale, void, pos_return, order,
  // exchange_in, exchange_out.
  // Adding: exchange_damaged
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order', 'return', 'adjustment', 'manual', 'initial_stock',
        'sale', 'void', 'pos_return', 'order',
        'exchange_in', 'exchange_out', 'exchange_damaged'
      ));
  `);

  // ── 1.6 Add lifecycle columns to exchanges ────────────────────────────────
  pgm.sql(`
    ALTER TABLE exchanges
      ADD COLUMN IF NOT EXISTS lifecycle_status TEXT
        CHECK (lifecycle_status IN (
          'INITIATED', 'REVIEWED', 'APPROVED', 'SETTLED', 'COMPLETED', 'CANCELLED'
        )),
      ADD COLUMN IF NOT EXISTS original_order_id BIGINT REFERENCES orders(id),
      ADD COLUMN IF NOT EXISTS customer_id_v2    INTEGER REFERENCES customers(id);
  `);

  // ── 1.7 Map existing exchange statuses to lifecycle_status ────────────────
  pgm.sql(`
    UPDATE exchanges SET lifecycle_status = 'INITIATED'
      WHERE status IN ('Initiated', 'Evaluated');
    UPDATE exchanges SET lifecycle_status = 'COMPLETED'
      WHERE status = 'Completed';
    UPDATE exchanges SET lifecycle_status = 'CANCELLED'
      WHERE status = 'Cancelled';
  `);

  // ── 1.8 Create exchange_items table (unified, additive) ───────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS exchange_items (
      id          BIGSERIAL     PRIMARY KEY,
      exchange_id BIGINT        NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
      book_id     INTEGER       NOT NULL REFERENCES books(id),
      quantity    INTEGER       NOT NULL CHECK (quantity > 0),
      unit_price  NUMERIC(12,2) NOT NULL,
      total_price NUMERIC(12,2) NOT NULL,
      type        TEXT          NOT NULL CHECK (type IN ('returned', 'new')),
      condition   TEXT          NOT NULL DEFAULT 'resellable'
                    CHECK (condition IN ('resellable', 'damaged')),
      created_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_exchange_items_exchange
      ON exchange_items (exchange_id);
  `);

  // ── 1.9 Create exchange_settlement_entries table ──────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS exchange_settlement_entries (
      id              BIGSERIAL     PRIMARY KEY,
      exchange_id     BIGINT        NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
      entry_type      TEXT          NOT NULL
                        CHECK (entry_type IN ('cash_payment', 'cash_refund', 'item_value_adjustment')),
      amount          NUMERIC(12,2) NOT NULL,
      currency        TEXT          NOT NULL DEFAULT 'ETB',
      method          TEXT,
      note            TEXT,
      override_reason TEXT,
      authorised_by   INTEGER REFERENCES staff(id),
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_settlement_entries_exchange
      ON exchange_settlement_entries (exchange_id);
  `);

  // ── 1.10 Create financial_transactions table ──────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS financial_transactions (
      id               BIGSERIAL     PRIMARY KEY,
      type             TEXT          NOT NULL
                         CHECK (type IN ('payment', 'refund', 'adjustment')),
      order_id         BIGINT        REFERENCES orders(id),
      exchange_id      BIGINT        REFERENCES exchanges(id),
      idempotency_key  TEXT          UNIQUE NOT NULL,
      amount           NUMERIC(12,2) NOT NULL,
      currency         TEXT          NOT NULL DEFAULT 'ETB',
      method           TEXT,
      staff_id         INTEGER       NOT NULL REFERENCES staff(id),
      branch_id        INTEGER       NOT NULL REFERENCES branches(id),
      meta             JSONB         NOT NULL DEFAULT '{}',
      created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT ft_must_reference_order_or_exchange
        CHECK (order_id IS NOT NULL OR exchange_id IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_ft_order
      ON financial_transactions (order_id)
      WHERE order_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_ft_exchange
      ON financial_transactions (exchange_id)
      WHERE exchange_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_ft_idem
      ON financial_transactions (idempotency_key);
  `);

  // ── 1.11 Add is_all_branches column to staff ──────────────────────────────
  pgm.sql(`
    ALTER TABLE staff
      ADD COLUMN IF NOT EXISTS is_all_branches BOOLEAN NOT NULL DEFAULT false;
  `);

  // ── 1.12 Ensure idempotency_keys table exists ─────────────────────────────
  // Already created in migration 1700000028_hardening.cjs.
  // Using CREATE TABLE IF NOT EXISTS for idempotency.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key              TEXT        PRIMARY KEY,
      endpoint         TEXT        NOT NULL,
      request_hash     TEXT        NOT NULL,
      response_payload JSONB       NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at       TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
    );
  `);
};

exports.down = function (pgm) {

  // ── Reverse 1.12 — idempotency_keys was created in migration 28; leave it ─
  // We do NOT drop idempotency_keys here because it was created by migration 28
  // and dropping it here would break migration 28's down function.

  // ── Reverse 1.11 ──────────────────────────────────────────────────────────
  pgm.sql(`
    ALTER TABLE staff
      DROP COLUMN IF EXISTS is_all_branches;
  `);

  // ── Reverse 1.10 ──────────────────────────────────────────────────────────
  pgm.sql(`
    DROP TABLE IF EXISTS financial_transactions;
  `);

  // ── Reverse 1.9 ───────────────────────────────────────────────────────────
  pgm.sql(`
    DROP TABLE IF EXISTS exchange_settlement_entries;
  `);

  // ── Reverse 1.8 ───────────────────────────────────────────────────────────
  pgm.sql(`
    DROP TABLE IF EXISTS exchange_items;
  `);

  // ── Reverse 1.7 + 1.6 ─────────────────────────────────────────────────────
  // lifecycle_status data cannot be meaningfully reversed; just drop the columns.
  pgm.sql(`
    ALTER TABLE exchanges
      DROP COLUMN IF EXISTS customer_id_v2,
      DROP COLUMN IF EXISTS original_order_id,
      DROP COLUMN IF EXISTS lifecycle_status;
  `);

  // ── Reverse 1.5 — restore constraint to values from migration 1700000027 ──
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order', 'return', 'adjustment', 'manual', 'initial_stock',
        'sale', 'void', 'pos_return', 'order',
        'exchange_in', 'exchange_out'
      ));
  `);

  // ── Reverse 1.4 ───────────────────────────────────────────────────────────
  pgm.sql(`
    ALTER TABLE inventory
      DROP COLUMN IF EXISTS damaged_quantity;
  `);

  // ── Reverse 1.3 ───────────────────────────────────────────────────────────
  pgm.sql(`
    DROP INDEX IF EXISTS idx_inv_res_book_loc;
    DROP INDEX IF EXISTS idx_inv_res_order;
    DROP TABLE IF EXISTS inventory_reservations;
  `);

  // ── Reverse 1.2 + 1.1 — restore legacy status values ─────────────────────
  // Map new statuses back to legacy values (best-effort; COMPLETED → Fulfilled).
  pgm.sql(`
    UPDATE orders SET status = 'Fulfilled' WHERE status = 'COMPLETED';
    UPDATE orders SET status = 'Fulfilled' WHERE status = 'FULFILLED';
    UPDATE orders SET status = 'Cancelled' WHERE status = 'CANCELLED';
    UPDATE orders SET status = 'Confirmed' WHERE status = 'CONFIRMED';
    UPDATE orders SET status = 'Pending'   WHERE status = 'DRAFT';
    UPDATE orders SET status = 'Pending'   WHERE status = 'PAID';
  `);

  pgm.sql(`
    ALTER TABLE orders
      DROP CONSTRAINT IF EXISTS orders_status_check;
    ALTER TABLE orders
      ADD CONSTRAINT orders_status_check
      CHECK (status IN ('Pending', 'Confirmed', 'In_Progress', 'Fulfilled', 'Cancelled'));
  `);
};
