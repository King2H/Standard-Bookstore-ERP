'use strict';

/**
 * Migration: Ensure is_all_branches column exists on staff table.
 *
 * This is a safety migration — migration 1700000033_erp_hardening.cjs already
 * adds this column (step 1.11). This migration exists as a guard for databases
 * that may have had migration 33 applied before the column was added, or for
 * any edge case where the column is missing.
 *
 * Using ADD COLUMN IF NOT EXISTS makes this fully idempotent.
 */

exports.shorthands = undefined;

exports.up = function (pgm) {
  // Ensure the column exists (no-op if already present from migration 33)
  pgm.sql(`
    ALTER TABLE staff
      ADD COLUMN IF NOT EXISTS is_all_branches BOOLEAN NOT NULL DEFAULT false;
  `);

  // Set superadmin and admin to all-branches by default
  pgm.sql(`
    UPDATE staff SET is_all_branches = true
    WHERE username IN ('superadmin', 'admin');
  `);
};

exports.down = function (pgm) {
  // Only drop if we added it (migration 33 down already handles this,
  // but IF EXISTS makes it safe to run either way)
  pgm.sql(`
    ALTER TABLE staff
      DROP COLUMN IF EXISTS is_all_branches;
  `);
};
