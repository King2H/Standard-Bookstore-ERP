'use strict';

// Slice 13 — Order Management
// Creates orders and order_line_items tables.
// payment_status is tracked here; updated by Payments module (Slice 14).

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE orders (
      id               BIGSERIAL PRIMARY KEY,
      order_number     TEXT UNIQUE NOT NULL,
      customer_id      INTEGER REFERENCES customers(id),
      branch_id        INTEGER NOT NULL REFERENCES branches(id),
      location_id      INTEGER REFERENCES locations(id),
      channel          TEXT NOT NULL DEFAULT 'in_store'
                         CHECK (channel IN ('in_store','phone','online')),
      status           TEXT NOT NULL DEFAULT 'Pending'
                         CHECK (status IN ('Pending','Confirmed','In_Progress','Fulfilled','Cancelled')),
      payment_status   TEXT NOT NULL DEFAULT 'unpaid'
                         CHECK (payment_status IN ('unpaid','partial','paid','refunded')),
      currency         TEXT NOT NULL DEFAULT 'ETB',
      subtotal         NUMERIC(14,2) NOT NULL DEFAULT 0,
      discount_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
      tax_rate         NUMERIC(6,4)  NOT NULL DEFAULT 0.10,
      tax_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
      total            NUMERIC(14,2) NOT NULL DEFAULT 0,
      cancel_reason    TEXT,
      notes            TEXT,
      created_by       INTEGER NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON orders (branch_id, status);
    CREATE INDEX ON orders (customer_id) WHERE customer_id IS NOT NULL;
    CREATE INDEX ON orders (status, payment_status);
    CREATE INDEX ON orders (created_at DESC);

    CREATE TABLE order_line_items (
      id              BIGSERIAL PRIMARY KEY,
      order_id        BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      book_id         INTEGER NOT NULL REFERENCES books(id),
      quantity        INTEGER NOT NULL CHECK (quantity > 0),
      unit_price      NUMERIC(14,2) NOT NULL,
      discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      total_price     NUMERIC(14,2) NOT NULL,
      qty_reserved    INTEGER NOT NULL DEFAULT 0,
      qty_fulfilled   INTEGER NOT NULL DEFAULT 0,
      is_backordered  BOOLEAN NOT NULL DEFAULT false
    );
    CREATE INDEX ON order_line_items (order_id);
    CREATE INDEX ON order_line_items (book_id);
  `);

  // Extend inventory_history reference_type to include 'order'
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order','return','adjustment','manual','initial_stock',
        'sale','void','pos_return','order'
      ));
  `);
};

exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS order_line_items;`);
  pgm.sql(`DROP TABLE IF EXISTS orders;`);
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order','return','adjustment','manual','initial_stock',
        'sale','void','pos_return'
      ));
  `);
};
