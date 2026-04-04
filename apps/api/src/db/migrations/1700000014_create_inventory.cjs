'use strict';

// Slice 7 — Inventory Management
// Creates inventory (stock per book per location) and inventory_history (partitioned audit trail).
// Optimistic locking via version counter on inventory rows.

exports.shorthands = undefined;

exports.up = function (pgm) {

  // ── inventory ──────────────────────────────────────────────────────────────
  // One row per (book, location). version is incremented on every mutation
  // to enable optimistic locking (concurrent writes detected via version mismatch).
  pgm.createTable('inventory', {
    book_id:       { type: 'integer', notNull: true, references: 'books(id)', onDelete: 'CASCADE' },
    location_id:   { type: 'integer', notNull: true, references: 'locations(id)', onDelete: 'CASCADE' },
    quantity:      { type: 'integer', notNull: true, default: 0 },
    reorder_point: { type: 'integer', notNull: true, default: 5 },
    version:       { type: 'integer', notNull: true, default: 0 },
    updated_at:    { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('inventory', 'inventory_pkey', 'PRIMARY KEY (book_id, location_id)');
  pgm.addConstraint('inventory', 'inventory_quantity_nonneg', 'CHECK (quantity >= 0)');
  pgm.addIndex('inventory', ['location_id']);
  // Partial index for low-stock queries
  pgm.sql(`CREATE INDEX inventory_low_stock_idx ON inventory (book_id, location_id) WHERE quantity <= reorder_point`);

  // ── inventory_history ──────────────────────────────────────────────────────
  // Partitioned by created_at (RANGE). Each row records one stock movement.
  // reason_code: 'damage' | 'loss' | 'return' | 'correction' | 'transfer_in' | 'transfer_out' | 'initial'
  pgm.sql(`
    CREATE TABLE inventory_history (
      id           BIGSERIAL    NOT NULL,
      book_id      INTEGER      NOT NULL REFERENCES books(id),
      location_id  INTEGER      NOT NULL REFERENCES locations(id),
      qty_before   INTEGER      NOT NULL,
      qty_after    INTEGER      NOT NULL,
      delta        INTEGER      NOT NULL,
      reason_code  TEXT         NOT NULL,
      notes        TEXT,
      staff_id     INTEGER      NOT NULL REFERENCES staff(id),
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at);
  `);

  // Create initial partitions: previous month, current month, next 2 months
  pgm.sql(`
    CREATE TABLE inventory_history_p_prev PARTITION OF inventory_history
      FOR VALUES FROM (date_trunc('month', now()) - interval '1 month')
                   TO (date_trunc('month', now()));

    CREATE TABLE inventory_history_p_cur PARTITION OF inventory_history
      FOR VALUES FROM (date_trunc('month', now()))
                   TO (date_trunc('month', now()) + interval '1 month');

    CREATE TABLE inventory_history_p_next1 PARTITION OF inventory_history
      FOR VALUES FROM (date_trunc('month', now()) + interval '1 month')
                   TO (date_trunc('month', now()) + interval '2 months');

    CREATE TABLE inventory_history_p_next2 PARTITION OF inventory_history
      FOR VALUES FROM (date_trunc('month', now()) + interval '2 months')
                   TO (date_trunc('month', now()) + interval '3 months');
  `);

  pgm.sql(`CREATE INDEX inventory_history_book_loc_idx ON inventory_history (book_id, location_id)`);
  pgm.sql(`CREATE INDEX inventory_history_staff_idx ON inventory_history (staff_id)`);
  pgm.sql(`CREATE INDEX inventory_history_created_idx ON inventory_history (created_at DESC)`);

  // ── Seed: initialize inventory rows for all existing books × locations ─────
  // quantity = 0, version = 0 — ready for first stock-in via procurement
  pgm.sql(`
    INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
    SELECT b.id, l.id, 0, 5, 0
    FROM books b
    CROSS JOIN locations l
    WHERE b.is_active = true
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`DROP TABLE IF EXISTS inventory_history_p_prev`);
  pgm.sql(`DROP TABLE IF EXISTS inventory_history_p_cur`);
  pgm.sql(`DROP TABLE IF EXISTS inventory_history_p_next1`);
  pgm.sql(`DROP TABLE IF EXISTS inventory_history_p_next2`);
  pgm.sql(`DROP TABLE IF EXISTS inventory_history`);
  pgm.dropTable('inventory');
};
