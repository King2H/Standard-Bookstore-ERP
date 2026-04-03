'use strict';

/**
 * Adds security columns to the staff table:
 * - failed_login_attempts: counter reset on successful login
 * - locked_until: NULL = not locked; timestamp = locked until this time
 * - must_change_password: set by Admin to force password change on next login
 * - last_login_at: updated on every successful login
 * - password_changed_at: updated whenever password is changed
 *
 * Also adds three new system_config keys for security policy.
 */
exports.shorthands = undefined;

exports.up = function (pgm) {
  // ── Staff security columns ─────────────────────────────────────────────────
  pgm.addColumns('staff', {
    failed_login_attempts: {
      type: 'integer',
      notNull: true,
      default: 0,
    },
    locked_until: {
      type: 'timestamptz',
      notNull: false,
      default: null,
    },
    must_change_password: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    last_login_at: {
      type: 'timestamptz',
      notNull: false,
      default: null,
    },
    password_changed_at: {
      type: 'timestamptz',
      notNull: false,
      default: null,
    },
  });

  // ── Security policy config keys ────────────────────────────────────────────
  pgm.sql(`
    INSERT INTO system_config (key, value, updated_by) VALUES
      ('max_failed_login_attempts', '5',   1),
      ('account_lockout_minutes',   '30',  1),
      ('password_expiry_days',      '0',   1)
    ON CONFLICT (key) DO NOTHING;
  `);
};

exports.down = function (pgm) {
  pgm.dropColumns('staff', [
    'failed_login_attempts',
    'locked_until',
    'must_change_password',
    'last_login_at',
    'password_changed_at',
  ]);
  pgm.sql(`
    DELETE FROM system_config
    WHERE key IN ('max_failed_login_attempts','account_lockout_minutes','password_expiry_days');
  `);
};
