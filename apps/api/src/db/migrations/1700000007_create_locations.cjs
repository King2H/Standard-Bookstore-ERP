'use strict';

exports.shorthands = undefined;

exports.up = function (pgm) {
  // ── locations ──────────────────────────────────────────────────────────────
  pgm.createTable('locations', {
    id:                     { type: 'serial', primaryKey: true },
    branch_id:              { type: 'integer', notNull: true, references: 'branches(id)', onDelete: 'RESTRICT' },
    name:                   { type: 'text', notNull: true },
    is_default_fulfillment: { type: 'boolean', notNull: true, default: false },
    created_at:             { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Unique name per branch
  pgm.addConstraint('locations', 'locations_branch_name_unique', 'UNIQUE (branch_id, name)');

  // Index for branch lookups
  pgm.addIndex('locations', ['branch_id']);

  // Partial unique index: at most one default per branch
  pgm.sql(`
    CREATE UNIQUE INDEX locations_one_default_per_branch
    ON locations (branch_id)
    WHERE is_default_fulfillment = true
  `);

  // Seed: insert one default location for every existing branch
  pgm.sql(`
    INSERT INTO locations (branch_id, name, is_default_fulfillment)
    SELECT id, 'Main Floor', true
    FROM branches
    ON CONFLICT DO NOTHING
  `);
};

exports.down = function (pgm) {
  pgm.dropIndex('locations', [], { name: 'locations_one_default_per_branch' });
  pgm.dropTable('locations');
};
