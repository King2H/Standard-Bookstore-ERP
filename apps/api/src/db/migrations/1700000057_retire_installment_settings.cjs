'use strict';

// Installment plans are retired (#21, owner decision 2026-10-10): staged
// payments, if ever needed, become a payment schedule on the receivable. Their
// settings go. The installment_plans and installments tables stay, with any
// plans in them, for reference: dropping financial records cannot be undone.

exports.shorthands = undefined;

const KEYS = `('min_deposit_pct', 'max_installments', 'installment_grace_period_days')`;

exports.up = function (pgm) {
  pgm.sql(`
    DELETE FROM branch_config WHERE key IN ${KEYS};
    DELETE FROM system_config WHERE key IN ${KEYS};
  `);
};

// Restores the defaults; branch overrides are not recorded anywhere to restore.
exports.down = function (pgm) {
  pgm.sql(`
    INSERT INTO system_config (key, value, updated_by)
    SELECT k, v::jsonb, (SELECT MIN(id) FROM staff)
    FROM (VALUES ('min_deposit_pct', '20'), ('max_installments', '12'), ('installment_grace_period_days', '0')) AS d(k, v)
    ON CONFLICT (key) DO NOTHING;
  `);
};
