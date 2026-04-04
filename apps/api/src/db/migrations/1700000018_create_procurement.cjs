'use strict';

// Slice 9 — Procurement & Purchase Orders

exports.shorthands = undefined;

exports.up = function (pgm) {
  // ── purchase_orders ──────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE purchase_orders (
      id                    BIGSERIAL PRIMARY KEY,
      branch_id             INTEGER NOT NULL REFERENCES branches(id),
      supplier_id           INTEGER NOT NULL REFERENCES suppliers(id),
      status                TEXT NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','pending_approval','approved','ordered','partially_received','received','closed','cancelled')),
      total_amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
      currency              TEXT NOT NULL DEFAULT 'USD',
      expected_delivery_date DATE,
      notes                 TEXT,
      created_by            INTEGER NOT NULL,
      approved_by           INTEGER,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON purchase_orders (branch_id, status);
    CREATE INDEX ON purchase_orders (supplier_id);
  `);

  // ── po_line_items ────────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE po_line_items (
      id                BIGSERIAL PRIMARY KEY,
      po_id             BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      book_id           INTEGER NOT NULL REFERENCES books(id),
      format_id         INTEGER REFERENCES book_formats(id),
      edition_id        INTEGER REFERENCES book_editions(id),
      quantity          INTEGER NOT NULL CHECK (quantity > 0),
      unit_cost         NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
      received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
      CONSTRAINT received_lte_ordered CHECK (received_quantity <= quantity)
    );
    CREATE INDEX ON po_line_items (po_id);
  `);

  // ── po_receipts ──────────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE po_receipts (
      id          BIGSERIAL PRIMARY KEY,
      po_id       BIGINT NOT NULL REFERENCES purchase_orders(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      received_by INTEGER NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      notes       TEXT
    );
    CREATE INDEX ON po_receipts (po_id);
  `);

  // ── po_receipt_items ─────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE po_receipt_items (
      id                BIGSERIAL PRIMARY KEY,
      receipt_id        BIGINT NOT NULL REFERENCES po_receipts(id) ON DELETE CASCADE,
      po_line_item_id   BIGINT NOT NULL REFERENCES po_line_items(id),
      quantity_received INTEGER NOT NULL CHECK (quantity_received > 0)
    );
    CREATE INDEX ON po_receipt_items (receipt_id);
  `);

  // ── Seed sample POs ──────────────────────────────────────────────────────
  pgm.sql(`
    DO $$
    DECLARE
      v_supplier_id INTEGER;
      v_book_id     INTEGER;
      v_branch_id   INTEGER;
      v_staff_id    INTEGER;
      v_po_id       BIGINT;
    BEGIN
      SELECT id INTO v_supplier_id FROM suppliers WHERE is_active = true AND is_blacklisted = false LIMIT 1;
      SELECT id INTO v_book_id     FROM books WHERE is_active = true LIMIT 1;
      SELECT id INTO v_branch_id   FROM branches LIMIT 1;
      SELECT id INTO v_staff_id    FROM staff LIMIT 1;

      IF v_supplier_id IS NOT NULL AND v_book_id IS NOT NULL AND v_branch_id IS NOT NULL AND v_staff_id IS NOT NULL THEN
        INSERT INTO purchase_orders (branch_id, supplier_id, status, total_amount, currency, notes, created_by)
        VALUES (v_branch_id, v_supplier_id, 'draft', 250.00, 'USD', 'Sample PO 1 (seed)', v_staff_id)
        RETURNING id INTO v_po_id;

        INSERT INTO po_line_items (po_id, book_id, quantity, unit_cost)
        VALUES (v_po_id, v_book_id, 10, 25.00);

        INSERT INTO purchase_orders (branch_id, supplier_id, status, total_amount, currency, notes, created_by)
        VALUES (v_branch_id, v_supplier_id, 'draft', 150.00, 'USD', 'Sample PO 2 (seed)', v_staff_id)
        RETURNING id INTO v_po_id;

        INSERT INTO po_line_items (po_id, book_id, quantity, unit_cost)
        VALUES (v_po_id, v_book_id, 5, 30.00);
      END IF;
    END $$;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS po_receipt_items CASCADE;
    DROP TABLE IF EXISTS po_receipts CASCADE;
    DROP TABLE IF EXISTS po_line_items CASCADE;
    DROP TABLE IF EXISTS purchase_orders CASCADE;
  `);
};
