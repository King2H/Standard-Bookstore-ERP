'use strict';

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.createTable('branches', {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true, unique: true },
    address: { type: 'text', notNull: true },
    contact_info: { type: 'jsonb', notNull: true },
    operating_hours: { type: 'jsonb', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint('staff_branch_roles', 'staff_branch_roles_branch_id_fkey', {
    foreignKeys: {
      columns: 'branch_id',
      references: 'branches(id)',
      onDelete: 'CASCADE',
    },
  });

  // Seed: default branch
  pgm.sql(`
    INSERT INTO branches (name, address, contact_info, operating_hours, is_active)
    VALUES (
      'Main Branch',
      '1 Bookstore Avenue, City',
      '{"phone": "555-0100", "email": "main@bookstore.com"}',
      '{"mon": "09:00-18:00", "tue": "09:00-18:00", "wed": "09:00-18:00", "thu": "09:00-18:00", "fri": "09:00-18:00", "sat": "10:00-16:00", "sun": "closed"}',
      true
    );
  `);

  // Assign Super_Admin to Main Branch
  pgm.sql(`
    INSERT INTO staff_branch_roles (staff_id, branch_id, role)
    SELECT s.id, b.id, 'Super_Admin'
    FROM staff s, branches b
    WHERE s.username = 'superadmin' AND b.name = 'Main Branch';
  `);
  // Assign Admin role to admin user on Main Branch
  pgm.sql(`
    INSERT INTO staff_branch_roles (staff_id, branch_id, role)
    SELECT s.id, b.id, 'Admin'
    FROM staff s, branches b
    WHERE s.username = 'admin' AND b.name = 'Main Branch';
  `);
};

exports.down = function (pgm) {
  pgm.dropConstraint('staff_branch_roles', 'staff_branch_roles_branch_id_fkey');
  pgm.dropTable('branches');
};
