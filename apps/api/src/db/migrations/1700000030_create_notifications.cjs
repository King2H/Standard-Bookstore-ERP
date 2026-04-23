'use strict';

/**
 * Migration: Create notifications table for the real-time notification system.
 *
 * Notifications are:
 * - Branch-scoped (staff only see their branch's notifications)
 * - Role-targeted (target_roles TEXT[] — broadcast to all staff with matching role)
 * - Optionally staff-targeted (target_staff_id — direct to a specific person)
 * - Persistent (stored in DB; retrievable after SSE reconnect)
 * - Indexed for fast unread-count queries
 */

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE notifications (
      id              BIGSERIAL    PRIMARY KEY,
      branch_id       INTEGER      REFERENCES branches(id) ON DELETE CASCADE,
      target_roles    TEXT[]       NOT NULL DEFAULT '{}',
      target_staff_id INTEGER      REFERENCES staff(id) ON DELETE CASCADE,
      event_type      TEXT         NOT NULL,
      title           TEXT         NOT NULL,
      body            TEXT         NOT NULL,
      entity_type     TEXT,
      entity_id       TEXT,
      severity        TEXT         NOT NULL DEFAULT 'info'
                        CHECK (severity IN ('info', 'success', 'warning', 'error')),
      is_read         BOOLEAN      NOT NULL DEFAULT false,
      read_at         TIMESTAMPTZ,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
    );

    -- GIN index for fast role-based queries (target_roles is an array)
    CREATE INDEX idx_notif_branch_roles
      ON notifications USING GIN (target_roles)
      WHERE branch_id IS NOT NULL;

    -- Btree index for direct staff queries (unread, recent first)
    CREATE INDEX idx_notif_staff
      ON notifications (target_staff_id, is_read, created_at DESC)
      WHERE target_staff_id IS NOT NULL;

    -- Partial index for fast unread-count queries per branch
    CREATE INDEX idx_notif_branch_unread
      ON notifications (branch_id, is_read, created_at DESC)
      WHERE is_read = false;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_notif_branch_unread;
    DROP INDEX IF EXISTS idx_notif_staff;
    DROP INDEX IF EXISTS idx_notif_branch_roles;
    DROP TABLE IF EXISTS notifications;
  `);
};
