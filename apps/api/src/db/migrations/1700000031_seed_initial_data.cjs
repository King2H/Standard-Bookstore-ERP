'use strict';

/**
 * Migration: Seed initial data required for the application to be usable.
 *
 * This runs automatically on startup (via start.sh → node-pg-migrate up).
 * All inserts are idempotent (ON CONFLICT DO NOTHING / DO UPDATE) so
 * re-running migrations on an already-seeded database is safe.
 *
 * Seeds:
 *  - Main Branch (id = 1)
 *  - superadmin staff (id = 1, role = Super_Admin)  password: Admin@1234
 *  - admin staff      (id = 2, role = Admin)         password: Admin@1234
 *  - Default "Main Floor" location for Main Branch
 *  - 21 system_config defaults
 */

exports.shorthands = undefined;

exports.up = function (pgm) {
  // ── Main Branch ────────────────────────────────────────────────────────────
  pgm.sql(`
    INSERT INTO branches (id, name, address, contact_info, operating_hours, is_active)
    VALUES (
      1,
      'Main Branch',
      '1 Bookstore Avenue, City',
      '{"phone":"555-0100","email":"main@bookstore.com"}',
      '{"mon":"09:00-18:00","tue":"09:00-18:00","wed":"09:00-18:00","thu":"09:00-18:00","fri":"09:00-18:00","sat":"10:00-16:00","sun":"closed"}',
      true
    )
    ON CONFLICT (id) DO UPDATE
      SET is_active = true,
          name      = EXCLUDED.name;
  `);

  // ── Staff accounts ─────────────────────────────────────────────────────────
  // Passwords are bcrypt hashes of 'Admin@1234' (cost 12).
  // Note: is_all_branches column is added in migration 33; we set it there.
  pgm.sql(`
    INSERT INTO staff (id, username, password_hash, full_name, is_active)
    VALUES
      (1, 'superadmin', '$2b$12$eMHKfE9UzGhT5GvCtB6w4.6/WRde0aH6DzJzluzr0Vzp6KPVA64NK', 'Super Admin', true),
      (2, 'admin',      '$2b$12$eMHKfE9UzGhT5GvCtB6w4.6/WRde0aH6DzJzluzr0Vzp6KPVA64NK', 'Admin User',  true)
    ON CONFLICT (id) DO UPDATE
      SET is_active        = true,
          username         = EXCLUDED.username,
          password_hash    = EXCLUDED.password_hash;
  `);

  // ── Role assignments ───────────────────────────────────────────────────────
  // Assign superadmin and admin to ALL active branches so they're not locked
  // to just the default Main Branch.
  pgm.sql(`
    INSERT INTO staff_branch_roles (staff_id, branch_id, role)
    SELECT 1, id, 'Super_Admin' FROM branches WHERE is_active = true
    ON CONFLICT DO NOTHING;
  `);
  pgm.sql(`
    INSERT INTO staff_branch_roles (staff_id, branch_id, role)
    SELECT 2, id, 'Admin' FROM branches WHERE is_active = true
    ON CONFLICT DO NOTHING;
  `);

  // ── Advance sequences past the seeded IDs ─────────────────────────────────
  pgm.sql(`
    SELECT setval('branches_id_seq', GREATEST((SELECT MAX(id) FROM branches), 1));
    SELECT setval('staff_id_seq',    GREATEST((SELECT MAX(id) FROM staff),    2));
  `);

  // ── Default location for Main Branch ──────────────────────────────────────
  pgm.sql(`
    INSERT INTO locations (branch_id, name, is_default_fulfillment)
    SELECT id, 'Main Floor', true
    FROM   branches
    ON CONFLICT DO NOTHING;
  `);

  // ── System config defaults ─────────────────────────────────────────────────
  pgm.sql(`
    INSERT INTO system_config (key, value, updated_by) VALUES
      ('base_currency',                    '"ETB"',                                          1),
      ('tax_rate',                         '0.15',                                           1),
      ('fiscal_year_start_month',          '1',                                              1),
      ('max_line_discount_pct',            '{"Sales":10,"Manager":25,"Admin":50}',           1),
      ('max_transaction_discount_pct',     '20',                                             1),
      ('discount_approval_threshold_pct',  '15',                                             1),
      ('reorder_point_default',            '5',                                              1),
      ('allow_negative_stock',             'false',                                          1),
      ('po_approval_threshold',            '1000.00',                                        1),
      ('default_supplier_lead_time_days',  '7',                                              1),
      ('return_window_days',               '30',                                             1),
      ('max_return_value_without_auth',    '500.00',                                         1),
      ('refund_method_after_window',       '"any"',                                          1),
      ('min_deposit_pct',                  '20',                                             1),
      ('max_installments',                 '12',                                             1),
      ('installment_grace_period_days',    '0',                                              1),
      ('loyalty_accrual_rate',             '0.01',                                           1),
      ('loyalty_redemption_rate',          '1.0',                                            1),
      ('loyalty_min_transaction_amount',   '0.00',                                           1),
      ('exchange_cash_adjustment_allowed', 'true',                                           1),
      ('notification_prefs',               '{}',                                             1)
    ON CONFLICT (key) DO NOTHING;
  `);
};

exports.down = function (pgm) {
  // Remove only the seeded rows — leave schema intact
  pgm.sql(`
    DELETE FROM system_config
    WHERE key IN (
      'base_currency','tax_rate','fiscal_year_start_month',
      'max_line_discount_pct','max_transaction_discount_pct',
      'discount_approval_threshold_pct','reorder_point_default',
      'allow_negative_stock','po_approval_threshold',
      'default_supplier_lead_time_days','return_window_days',
      'max_return_value_without_auth','refund_method_after_window',
      'min_deposit_pct','max_installments','installment_grace_period_days',
      'loyalty_accrual_rate','loyalty_redemption_rate',
      'loyalty_min_transaction_amount','exchange_cash_adjustment_allowed',
      'notification_prefs'
    );
    DELETE FROM staff_branch_roles WHERE staff_id IN (1, 2);
    DELETE FROM staff WHERE id IN (1, 2);
    DELETE FROM locations WHERE branch_id = 1 AND name = 'Main Floor';
    DELETE FROM branches WHERE id = 1;
  `);
};
