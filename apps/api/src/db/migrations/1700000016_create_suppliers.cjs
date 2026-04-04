'use strict';

// Slice 8 — Supplier Management
// Creates suppliers and book_suppliers tables with unified party model.

exports.shorthands = undefined;

exports.up = function (pgm) {
  // ── suppliers ──────────────────────────────────────────────────────────────
  pgm.createTable('suppliers', {
    id:             { type: 'serial', primaryKey: true },
    name:           { type: 'text', notNull: true, unique: true },
    contact_info:   { type: 'jsonb', notNull: true },
    lead_time_days: { type: 'integer', notNull: true, default: 7 },
    pricing_terms:  { type: 'text' },
    supplier_type:  {
      type: 'text',
      notNull: true,
      default: 'external',
    },
    publisher_id:   { type: 'integer', references: 'publishers(id)', onDelete: 'SET NULL' },
    is_active:      { type: 'boolean', notNull: true, default: true },
    is_blacklisted: { type: 'boolean', notNull: true, default: false },
    created_at:     { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // CHECK constraints
  pgm.sql(`
    ALTER TABLE suppliers
      ADD CONSTRAINT suppliers_supplier_type_check
        CHECK (supplier_type IN ('external', 'publisher')),
      ADD CONSTRAINT publisher_supplier_requires_publisher_id
        CHECK (supplier_type != 'publisher' OR publisher_id IS NOT NULL),
      ADD CONSTRAINT external_supplier_no_publisher_id
        CHECK (supplier_type != 'external' OR publisher_id IS NULL);
  `);

  pgm.addIndex('suppliers', ['supplier_type']);
  pgm.addIndex('suppliers', ['is_active']);

  // ── book_suppliers ─────────────────────────────────────────────────────────
  pgm.createTable('book_suppliers', {
    book_id:      { type: 'integer', notNull: true, references: 'books(id)', onDelete: 'CASCADE' },
    supplier_id:  { type: 'integer', notNull: true, references: 'suppliers(id)', onDelete: 'CASCADE' },
    supplier_sku: { type: 'text' },
    is_primary:   { type: 'boolean', notNull: true, default: false },
  });

  pgm.addConstraint('book_suppliers', 'book_suppliers_pkey', 'PRIMARY KEY (book_id, supplier_id)');
  pgm.addIndex('book_suppliers', ['supplier_id']);

  // Partial index: at most one primary supplier per book
  pgm.sql(`
    CREATE UNIQUE INDEX book_suppliers_primary_idx
      ON book_suppliers (book_id)
      WHERE is_primary = true;
  `);

  // ── Seed: external supplier ────────────────────────────────────────────────
  pgm.sql(`
    INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type)
    VALUES ('Book Distributors Inc', '{"phone":"555-1000","email":"orders@bookdist.com"}', 5, 'external')
    ON CONFLICT (name) DO NOTHING;
  `);

  // ── Seed: publisher-linked supplier (safe — skips if no publisher exists) ──
  pgm.sql(`
    DO $$
    DECLARE pub_id INTEGER;
    BEGIN
      SELECT id INTO pub_id FROM publishers LIMIT 1;
      IF pub_id IS NOT NULL THEN
        INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type, publisher_id)
        VALUES ('Oxford University Press Direct', '{"phone":"555-2000","email":"supply@oup.com"}', 14, 'publisher', pub_id)
        ON CONFLICT (name) DO NOTHING;
      END IF;
    END $$;
  `);
};

exports.down = function (pgm) {
  pgm.dropTable('book_suppliers');
  pgm.dropTable('suppliers');
};
