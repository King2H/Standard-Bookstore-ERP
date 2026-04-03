'use strict';

exports.shorthands = undefined;

exports.up = function (pgm) {
  // ── staff_locations ────────────────────────────────────────────────────────
  // Optional scoped access: a staff member may be restricted to specific
  // locations within their branch. If no rows exist for a staff member,
  // they have access to ALL locations in their branch (fallback mode).
  pgm.createTable('staff_locations', {
    staff_id:    { type: 'integer', notNull: true, references: 'staff(id)', onDelete: 'CASCADE' },
    location_id: { type: 'integer', notNull: true, references: 'locations(id)', onDelete: 'CASCADE' },
  });

  pgm.addConstraint('staff_locations', 'staff_locations_pkey', 'PRIMARY KEY (staff_id, location_id)');
  pgm.addIndex('staff_locations', ['staff_id']);
  pgm.addIndex('staff_locations', ['location_id']);
};

exports.down = function (pgm) {
  pgm.dropTable('staff_locations');
};
