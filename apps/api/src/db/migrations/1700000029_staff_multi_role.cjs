'use strict';

/**
 * Migration: Allow staff to have multiple roles per branch.
 *
 * Previously: PRIMARY KEY (staff_id, branch_id) — one role per branch.
 * Now: PRIMARY KEY (id) with UNIQUE (staff_id, branch_id, role) — multiple roles per branch allowed.
 *
 * The login flow picks the first role found for the selected branch (backward compatible).
 * The JWT still carries a single role (the one the staff logged in with).
 */

exports.shorthands = undefined;

exports.up = function (pgm) {
  // 1. Drop the old composite primary key
  pgm.dropConstraint('staff_branch_roles', 'staff_branch_roles_pkey');

  // 2. Add a serial surrogate primary key
  pgm.addColumn('staff_branch_roles', {
    id: { type: 'serial', notNull: true },
  });

  // 3. Set the new primary key
  pgm.addConstraint('staff_branch_roles', 'staff_branch_roles_pkey', {
    primaryKey: ['id'],
  });

  // 4. Add unique constraint to prevent exact duplicate (staff + branch + role)
  pgm.addConstraint('staff_branch_roles', 'staff_branch_roles_unique', {
    unique: ['staff_id', 'branch_id', 'role'],
  });
};

exports.down = function (pgm) {
  pgm.dropConstraint('staff_branch_roles', 'staff_branch_roles_unique');
  pgm.dropConstraint('staff_branch_roles', 'staff_branch_roles_pkey');
  pgm.dropColumn('staff_branch_roles', 'id');
  pgm.addConstraint('staff_branch_roles', 'staff_branch_roles_pkey', {
    primaryKey: ['staff_id', 'branch_id'],
  });
};
