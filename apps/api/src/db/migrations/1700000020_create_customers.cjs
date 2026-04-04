'use strict';

// Slice 10 — Customer Management
// Creates customers, customer_groups, loyalty, and store credit tables.

exports.shorthands = undefined;

exports.up = function (pgm) {
  // ── customers ──────────────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE customers (
      id            SERIAL PRIMARY KEY,
      branch_id     INTEGER REFERENCES branches(id),
      customer_code TEXT UNIQUE NOT NULL,
      full_name     TEXT NOT NULL,
      phone         TEXT,
      email         TEXT,
      gender        TEXT CHECK (gender IN ('male','female','other')),
      date_of_birth DATE,
      address       TEXT,
      city          TEXT,
      is_active     BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by    INTEGER
    );
    CREATE INDEX ON customers (phone);
    CREATE INDEX ON customers (email);
    CREATE INDEX ON customers (customer_code);
    CREATE INDEX ON customers (branch_id, is_active);
  `);

  // ── customer_groups ────────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE customer_groups (
      id           SERIAL PRIMARY KEY,
      name         TEXT UNIQUE NOT NULL,
      description  TEXT,
      discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0
    );
  `);

  // ── customer_group_membership ──────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE customer_group_membership (
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      group_id    INTEGER NOT NULL REFERENCES customer_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (customer_id, group_id)
    );
  `);

  // ── loyalty_accounts ───────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE loyalty_accounts (
      customer_id     INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
      points_balance  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
      lifetime_points NUMERIC(14,2) NOT NULL DEFAULT 0,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ── loyalty_history ────────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE loyalty_history (
      id              BIGSERIAL PRIMARY KEY,
      customer_id     INTEGER NOT NULL REFERENCES customers(id),
      transaction_ref TEXT,
      points_delta    NUMERIC(14,2) NOT NULL,
      reason          TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON loyalty_history (customer_id);
  `);

  // ── store_credit_accounts ──────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE store_credit_accounts (
      customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
      balance     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0)
    );
  `);

  // ── store_credit_history ───────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE store_credit_history (
      id          BIGSERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      ref_type    TEXT,
      ref_id      TEXT,
      amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      direction   TEXT NOT NULL CHECK (direction IN ('credit','debit')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON store_credit_history (customer_id);
  `);

  // ── Seed: 2 customer groups ────────────────────────────────────────────────
  pgm.sql(`
    INSERT INTO customer_groups (name, description, discount_pct)
    VALUES
      ('VIP',     'VIP customers with premium benefits', 10.00),
      ('Regular', 'Standard customer group',              0.00)
    ON CONFLICT (name) DO NOTHING;
  `);

  // ── Seed: 3 sample customers with loyalty + store credit ──────────────────
  pgm.sql(`
    DO $$
    DECLARE
      branch_id_val INTEGER;
      c1_id INTEGER;
      c2_id INTEGER;
      c3_id INTEGER;
    BEGIN
      SELECT id INTO branch_id_val FROM branches LIMIT 1;

      INSERT INTO customers (branch_id, customer_code, full_name, phone, email, gender, is_active, created_at)
      VALUES (branch_id_val, 'CUS-0001', 'Alice Johnson', '555-1001', 'alice@example.com', 'female', true, now())
      ON CONFLICT (customer_code) DO NOTHING
      RETURNING id INTO c1_id;

      IF c1_id IS NOT NULL THEN
        INSERT INTO loyalty_accounts (customer_id, points_balance, lifetime_points, updated_at)
        VALUES (c1_id, 150, 500, now());
        INSERT INTO store_credit_accounts (customer_id, balance)
        VALUES (c1_id, 25.00);
      END IF;

      INSERT INTO customers (branch_id, customer_code, full_name, phone, email, gender, is_active, created_at)
      VALUES (branch_id_val, 'CUS-0002', 'Bob Smith', '555-1002', 'bob@example.com', 'male', true, now())
      ON CONFLICT (customer_code) DO NOTHING
      RETURNING id INTO c2_id;

      IF c2_id IS NOT NULL THEN
        INSERT INTO loyalty_accounts (customer_id, points_balance, lifetime_points, updated_at)
        VALUES (c2_id, 0, 0, now());
        INSERT INTO store_credit_accounts (customer_id, balance)
        VALUES (c2_id, 0.00);
      END IF;

      INSERT INTO customers (branch_id, customer_code, full_name, phone, email, gender, is_active, created_at)
      VALUES (branch_id_val, 'CUS-0003', 'Carol White', '555-1003', 'carol@example.com', 'female', true, now())
      ON CONFLICT (customer_code) DO NOTHING
      RETURNING id INTO c3_id;

      IF c3_id IS NOT NULL THEN
        INSERT INTO loyalty_accounts (customer_id, points_balance, lifetime_points, updated_at)
        VALUES (c3_id, 75, 200, now());
        INSERT INTO store_credit_accounts (customer_id, balance)
        VALUES (c3_id, 10.00);
      END IF;
    END $$;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS store_credit_history;
    DROP TABLE IF EXISTS store_credit_accounts;
    DROP TABLE IF EXISTS loyalty_history;
    DROP TABLE IF EXISTS loyalty_accounts;
    DROP TABLE IF EXISTS customer_group_membership;
    DROP TABLE IF EXISTS customer_groups;
    DROP TABLE IF EXISTS customers;
  `);
};
