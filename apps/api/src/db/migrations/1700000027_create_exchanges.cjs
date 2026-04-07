'use strict';

// Slice 15 — Merchant Exchange (In-Kind)
// Enables book-to-book exchanges with value comparison and settlement.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE exchanges (
      id                    BIGSERIAL PRIMARY KEY,
      exchange_reference    TEXT UNIQUE NOT NULL,
      branch_id             INTEGER NOT NULL REFERENCES branches(id),
      location_id           INTEGER REFERENCES locations(id),
      customer_id           INTEGER REFERENCES customers(id),
      status                TEXT NOT NULL DEFAULT 'Initiated'
                              CHECK (status IN ('Initiated','Evaluated','Completed','Cancelled')),
      total_incoming_value  NUMERIC(14,2) NOT NULL DEFAULT 0,
      total_outgoing_value  NUMERIC(14,2) NOT NULL DEFAULT 0,
      net_balance           NUMERIC(14,2) NOT NULL DEFAULT 0,
      settlement_type       TEXT NOT NULL DEFAULT 'Even'
                              CHECK (settlement_type IN ('Even','Customer_Pays','Store_Refunds')),
      currency              TEXT NOT NULL DEFAULT 'ETB',
      notes                 TEXT,
      related_payment_id    BIGINT REFERENCES order_payments(id),
      created_by            INTEGER NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON exchanges (branch_id, status);
    CREATE INDEX ON exchanges (customer_id) WHERE customer_id IS NOT NULL;
    CREATE INDEX ON exchanges (created_at DESC);

    CREATE TABLE exchange_incoming_items (
      id                   BIGSERIAL PRIMARY KEY,
      exchange_id          BIGINT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
      book_id              INTEGER NOT NULL REFERENCES books(id),
      quantity             INTEGER NOT NULL CHECK (quantity > 0),
      evaluated_unit_price NUMERIC(14,2) NOT NULL CHECK (evaluated_unit_price >= 0),
      total_price          NUMERIC(14,2) NOT NULL
    );
    CREATE INDEX ON exchange_incoming_items (exchange_id);

    CREATE TABLE exchange_outgoing_items (
      id                  BIGSERIAL PRIMARY KEY,
      exchange_id         BIGINT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
      book_id             INTEGER NOT NULL REFERENCES books(id),
      quantity            INTEGER NOT NULL CHECK (quantity > 0),
      selling_unit_price  NUMERIC(14,2) NOT NULL CHECK (selling_unit_price >= 0),
      total_price         NUMERIC(14,2) NOT NULL
    );
    CREATE INDEX ON exchange_outgoing_items (exchange_id);
  `);

  // Extend inventory_history reference_type to include 'exchange_in' and 'exchange_out'
  pgm.sql(`
    ALTER TABLE inventory_history
      DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
    ALTER TABLE inventory_history
      ADD CONSTRAINT inventory_history_reference_type_check
      CHECK (reference_type IS NULL OR reference_type IN (
        'purchase_order','return','adjustment','manual','initial_stock',
        'sale','void','pos_return','order','exchange_in','exchange_out'
      ));
  `);
};

exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS exchange_outgoing_items;`);
  pgm.sql(`DROP TABLE IF EXISTS exchange_incoming_items;`);
  pgm.sql(`DROP TABLE IF EXISTS exchanges;`);
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
