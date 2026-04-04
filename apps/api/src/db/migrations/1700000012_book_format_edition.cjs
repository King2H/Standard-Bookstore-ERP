'use strict';

// Adds book_formats and book_editions lookup tables.
// Adds format_id and edition_id FKs on books (nullable for backward compat).
// Extends book_branch_prices to support per-format/edition pricing.

exports.shorthands = undefined;

exports.up = function (pgm) {
  // ── book_formats ───────────────────────────────────────────────────────────
  pgm.createTable('book_formats', {
    id:         { type: 'serial', primaryKey: true },
    code:       { type: 'text', notNull: true, unique: true },
    label:      { type: 'text', notNull: true },
    sort_order: { type: 'smallint', notNull: true, default: 0 },
  });

  pgm.sql(`
    INSERT INTO book_formats (code, label, sort_order) VALUES
      ('softcover',         'Softcover',          1),
      ('hardcover',         'Hardcover',          2),
      ('leather_bound',     'Leather Bound',      3),
      ('cloth_bound',       'Cloth Bound',        4),
      ('traditional_orthodox', 'Traditional/Orthodox', 5)
    ON CONFLICT (code) DO NOTHING;
  `);

  // ── book_editions ──────────────────────────────────────────────────────────
  pgm.createTable('book_editions', {
    id:         { type: 'serial', primaryKey: true },
    code:       { type: 'text', notNull: true, unique: true },
    label:      { type: 'text', notNull: true },
    sort_order: { type: 'smallint', notNull: true, default: 0 },
  });

  pgm.sql(`
    INSERT INTO book_editions (code, label, sort_order) VALUES
      ('first_edition',      'First Edition',       1),
      ('revised_edition',    'Revised Edition',     2),
      ('student_edition',    'Student Edition',     3),
      ('annotated',          'Annotated',           4),
      ('special_religious',  'Special/Religious',   5)
    ON CONFLICT (code) DO NOTHING;
  `);

  // ── Add format_id + edition_id to books ────────────────────────────────────
  pgm.addColumn('books', {
    format_id: {
      type: 'integer',
      references: 'book_formats(id)',
      onDelete: 'SET NULL',
    },
  });
  pgm.addColumn('books', {
    edition_id: {
      type: 'integer',
      references: 'book_editions(id)',
      onDelete: 'SET NULL',
    },
  });

  // Migrate existing free-text format values to format_id where possible
  pgm.sql(`
    UPDATE books SET format_id = bf.id
    FROM book_formats bf
    WHERE lower(books.format) = lower(bf.code)
       OR lower(books.format) = lower(bf.label);
  `);

  // ── Extend book_branch_prices for format/edition pricing ──────────────────
  // Drop old PK, add NOT NULL format_id + edition_id with default 0 (= base price),
  // recreate composite PK. Using 0 as sentinel avoids NULL equality issues.
  pgm.sql(`
    ALTER TABLE book_branch_prices
      DROP CONSTRAINT book_branch_prices_pkey;

    ALTER TABLE book_branch_prices
      ADD COLUMN format_id  INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN edition_id INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE book_branch_prices
      ADD CONSTRAINT book_branch_prices_pkey
      PRIMARY KEY (book_id, branch_id, format_id, edition_id);
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE book_branch_prices DROP CONSTRAINT book_branch_prices_pkey;
    ALTER TABLE book_branch_prices DROP COLUMN IF EXISTS format_id;
    ALTER TABLE book_branch_prices DROP COLUMN IF EXISTS edition_id;
    ALTER TABLE book_branch_prices ADD CONSTRAINT book_branch_prices_pkey PRIMARY KEY (book_id, branch_id);
  `);
  pgm.dropColumn('books', 'edition_id');
  pgm.dropColumn('books', 'format_id');
  pgm.dropTable('book_editions');
  pgm.dropTable('book_formats');
};
