'use strict';

// Per-person notification read state (#85). A notification sent to a role is
// one row, so its is_read flag was shared: when one Manager opened it, it
// was read for every Manager. Each recipient's reads are now kept here.
//
// notifications.is_read and read_at stay: they record what was read before
// this migration, which stays read for everyone. Nothing sets them any more.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.createTable('notification_reads', {
    notification_id: { type: 'bigint', notNull: true, references: 'notifications(id)', onDelete: 'CASCADE' },
    staff_id: { type: 'integer', notNull: true, references: 'staff(id)', onDelete: 'CASCADE' },
    read_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('notification_reads', 'notification_reads_pkey', 'PRIMARY KEY (notification_id, staff_id)');
  pgm.addIndex('notification_reads', ['staff_id']);
};

exports.down = function (pgm) {
  pgm.dropTable('notification_reads');
};
