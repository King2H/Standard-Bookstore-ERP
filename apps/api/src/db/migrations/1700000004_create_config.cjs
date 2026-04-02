'use strict';

exports.shorthands = undefined;

exports.up = function (pgm) {
  // ── system_config ──────────────────────────────────────────────────────────
  pgm.createTable('system_config', {
    key:        { type: 'text', primaryKey: true },
    value:      { type: 'jsonb', notNull: true },
    updated_by: { type: 'integer', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // ── branch_config ──────────────────────────────────────────────────────────
  pgm.createTable('branch_config', {
    branch_id:  { type: 'integer', notNull: true, references: 'branches(id)', onDelete: 'CASCADE' },
    key:        { type: 'text', notNull: true },
    value:      { type: 'jsonb', notNull: true },
    updated_by: { type: 'integer', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('branch_config', 'branch_config_pkey', 'PRIMARY KEY (branch_id, key)');

  // ── Seed: 21 system_config defaults (updated_by = 1 = superadmin) ──────────
  pgm.sql(`
    INSERT INTO system_config (key, value, updated_by) VALUES
      ('base_currency',                    '"USD"',                                          1),
      ('tax_rate',                         '0.10',                                           1),
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
      ('notification_prefs',               '{}',                                             1);
  `);
};

exports.down = function (pgm) {
  pgm.dropTable('branch_config');
  pgm.dropTable('system_config');
};
