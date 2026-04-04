'use strict';

// Fixes book_branch_prices PK: replaces nullable format_id/edition_id
// with NOT NULL DEFAULT 0 columns so ON CONFLICT works correctly.
// 0 = sentinel for "base price" (no specific format/edition).

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    -- Drop the broken PK with nullable columns
    ALTER TABLE book_branch_prices DROP CONSTRAINT IF EXISTS book_branch_prices_pkey;

    -- Drop the nullable columns added in migration 12
    ALTER TABLE book_branch_prices
      DROP COLUMN IF EXISTS format_id,
      DROP COLUMN IF EXISTS edition_id;

    -- Re-add as NOT NULL with default 0 (sentinel = base price)
    ALTER TABLE book_branch_prices
      ADD COLUMN format_id  INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN edition_id INTEGER NOT NULL DEFAULT 0;

    -- Recreate PK
    ALTER TABLE book_branch_prices
      ADD CONSTRAINT book_branch_prices_pkey
      PRIMARY KEY (book_id, branch_id, format_id, edition_id);
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE book_branch_prices DROP CONSTRAINT IF EXISTS book_branch_prices_pkey;
    ALTER TABLE book_branch_prices DROP COLUMN IF EXISTS format_id;
    ALTER TABLE book_branch_prices DROP COLUMN IF EXISTS edition_id;
    ALTER TABLE book_branch_prices ADD CONSTRAINT book_branch_prices_pkey PRIMARY KEY (book_id, branch_id);
  `);
};
