'use strict';

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.createTable('audit_logs', {
    id: { type: 'bigserial', primaryKey: true },
    staff_id: { type: 'integer', notNull: false },
    staff_role: { type: 'text', notNull: false },
    action: { type: 'text', notNull: true },
    entity_type: { type: 'text', notNull: true },
    entity_id: { type: 'text', notNull: true },
    branch_id: { type: 'integer', notNull: false },
    meta: { type: 'jsonb', notNull: false },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('audit_logs', ['entity_type', 'entity_id']);
  pgm.createIndex('audit_logs', ['staff_id']);
  pgm.createIndex('audit_logs', ['created_at']);
};

exports.down = function (pgm) {
  pgm.dropTable('audit_logs');
};
