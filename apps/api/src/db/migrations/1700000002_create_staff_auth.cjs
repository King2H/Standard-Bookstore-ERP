'use strict';

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.createTable('staff', {
    id: { type: 'serial', primaryKey: true },
    username: { type: 'text', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    full_name: { type: 'text', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createTable('staff_branch_roles', {
    staff_id: {
      type: 'integer',
      notNull: true,
      references: '"staff"',
      onDelete: 'CASCADE',
    },
    branch_id: { type: 'integer', notNull: true },
    role: {
      type: 'text',
      notNull: true,
      check: `role IN ('Super_Admin','Admin','Manager','Finance_Officer','Stock_Clerk','Sales','Purchasor')`,
    },
  });

  pgm.addConstraint('staff_branch_roles', 'staff_branch_roles_pkey', {
    primaryKey: ['staff_id', 'branch_id'],
  });

  pgm.createIndex('staff_branch_roles', ['branch_id']);

  pgm.createTable('refresh_tokens', {
    id: { type: 'bigserial', primaryKey: true },
    staff_id: {
      type: 'integer',
      notNull: true,
      references: '"staff"',
      onDelete: 'CASCADE',
    },
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked: { type: 'boolean', notNull: true, default: false },
  });

  pgm.createIndex('refresh_tokens', ['staff_id', 'revoked']);

  // Seed: superadmin / password
  pgm.sql(`
    INSERT INTO staff (username, password_hash, full_name, is_active)
    VALUES (
      'superadmin',
      '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
      'Super Administrator',
      true
    );
  `);
  // Seed: admin / password (for local dev testing of Admin role)
  pgm.sql(`
    INSERT INTO staff (username, password_hash, full_name, is_active)
    VALUES (
      'admin',
      '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
      'System Administrator',
      true
    );
  `);
};

exports.down = function (pgm) {
  pgm.dropTable('refresh_tokens');
  pgm.dropTable('staff_branch_roles');
  pgm.dropTable('staff');
};
