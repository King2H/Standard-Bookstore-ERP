'use strict';

exports.shorthands = undefined;

// Master Data Lifecycle refactor (Prompt 3) — adds a unified
// ACTIVE / INACTIVE / ARCHIVED status model to authors, categories,
// publishers, books, suppliers, and customers.
//
// Purely additive — no columns dropped, no rows deleted, no existing
// booleans (books.is_active, suppliers.is_active/is_blacklisted,
// customers.is_active) removed. Those booleans stay as the
// derived/synced flag consumer-module guards already check; `status`
// is the new source of truth going forward and is what search/dropdown
// filtering and archive/restore now key off.
//
// Note: archived_by/updated_by are `integer REFERENCES staff(id)`, not
// `uuid` — every staff/created_by/updated_by column in this schema
// (and the JWT staffId claim itself) is integer.
exports.up = async function (pgm) {
  const lifecycleColumns = () => ({
    status:      { type: 'text', notNull: true, default: 'ACTIVE' },
    archived_at: { type: 'timestamptz' },
    archived_by: { type: 'integer', references: 'staff(id)' },
    updated_at:  { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_by:  { type: 'integer', references: 'staff(id)' },
  });

  for (const table of ['authors', 'categories', 'publishers', 'books', 'suppliers', 'customers']) {
    pgm.addColumns(table, lifecycleColumns());
    pgm.addConstraint(table, `${table}_status_check`, `CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED'))`);
    pgm.addIndex(table, ['status']);
  }

  // Backfill: entities that already had is_active=false predate this
  // migration and should read as INACTIVE (not silently reactivated) —
  // authors/categories/publishers had no is_active concept at all, so
  // they simply default to ACTIVE (their prior implicit state).
  pgm.sql(`UPDATE books SET status = 'INACTIVE' WHERE is_active = false`);
  pgm.sql(`UPDATE suppliers SET status = 'INACTIVE' WHERE is_active = false`);
  pgm.sql(`UPDATE customers SET status = 'INACTIVE' WHERE is_active = false`);
};

exports.down = function (pgm) {
  for (const table of ['authors', 'categories', 'publishers', 'books', 'suppliers', 'customers']) {
    pgm.dropConstraint(table, `${table}_status_check`);
    pgm.dropColumns(table, ['status', 'archived_at', 'archived_by', 'updated_at', 'updated_by']);
  }
};
