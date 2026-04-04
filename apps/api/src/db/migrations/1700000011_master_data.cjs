'use strict';

// Adds publishers table, publisher_id FK on books, and parent_id on categories.
// Migrates existing books.publisher text → publishers table.

exports.shorthands = undefined;

exports.up = function (pgm) {
  // ── publishers ─────────────────────────────────────────────────────────────
  pgm.createTable('publishers', {
    id:         { type: 'serial', primaryKey: true },
    name:       { type: 'text', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addIndex('publishers', ['name']);

  // ── categories: add parent_id for hierarchy ────────────────────────────────
  pgm.addColumn('categories', {
    parent_id: { type: 'integer', references: 'categories(id)', onDelete: 'SET NULL' },
  });

  // ── books: add publisher_id FK ─────────────────────────────────────────────
  pgm.addColumn('books', {
    publisher_id: { type: 'integer', references: 'publishers(id)', onDelete: 'SET NULL' },
  });

  // ── Migrate existing publisher text values → publishers table ──────────────
  pgm.sql(`
    INSERT INTO publishers (name)
    SELECT DISTINCT publisher FROM books
    WHERE publisher IS NOT NULL AND trim(publisher) <> ''
    ON CONFLICT (name) DO NOTHING;

    UPDATE books b
    SET publisher_id = p.id
    FROM publishers p
    WHERE b.publisher = p.name;
  `);
};

exports.down = function (pgm) {
  pgm.dropColumn('books', 'publisher_id');
  pgm.dropColumn('categories', 'parent_id');
  pgm.dropTable('publishers');
};
