'use strict';

/**
 * Migration: Add branch_id and role to refresh_tokens.
 *
 * The refresh endpoint previously JOINed staff_branch_roles to reconstruct
 * the JWT context, but this breaks when a staff member has multiple roles
 * (the JOIN returns multiple rows, causing non-deterministic token matching).
 *
 * Storing branch_id + role directly on the token ensures the refreshed JWT
 * always carries the same context as the original login.
 */

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.addColumn('refresh_tokens', {
    branch_id: { type: 'integer', notNull: false },
    role:      { type: 'text',    notNull: false },
  });
};

exports.down = function (pgm) {
  pgm.dropColumn('refresh_tokens', 'role');
  pgm.dropColumn('refresh_tokens', 'branch_id');
};
