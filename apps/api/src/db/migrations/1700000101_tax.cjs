'use strict';

// Tax (#247, owner decisions 1a–4a, 2026-11-11; ADR-0010).
//
// A shop runs with tax off (every shop starts so), or on at one rate under a
// name, set by Super_Admin or Admin. Prices include tax: each sale, order,
// return and exchange keeps the rate it was made at and the tax inside its
// amount, so a change of rate never changes what was recorded.
//
// - Settings tax_enabled (false), tax_rate_pct (15) and tax_name ("VAT") for
//   every shop. The old tax_rate setting, never read, goes.
// - transactions.tax_rate (the column of tax_total's rate); returns and
//   exchanges get tax_rate and tax_amount.
// - orders.tax_rate defaulted to 0.10 from v1 while no order was ever taxed
//   (tax_amount 0): such orders are set to the rate they were made at, 0.

exports.shorthands = undefined;

const RATE = 'numeric(6,4) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 1)';
const AMOUNT = 'numeric(14,2) NOT NULL DEFAULT 0';

exports.up = function (pgm) {
  pgm.sql(`
    DELETE FROM branch_config WHERE key = 'tax_rate';
    DELETE FROM system_config WHERE key = 'tax_rate';
    INSERT INTO system_config (tenant_id, key, value, updated_by)
    SELECT t.id, k.key, k.value, COALESCE((SELECT MIN(s.id) FROM staff s WHERE s.tenant_id = t.id), 1)
    FROM tenants t
    CROSS JOIN (VALUES ('tax_enabled', 'false'::jsonb), ('tax_rate_pct', '15'::jsonb), ('tax_name', '"VAT"'::jsonb)) AS k(key, value)
    ON CONFLICT (tenant_id, key) DO NOTHING;

    ALTER TABLE transactions ADD COLUMN tax_rate ${RATE};
    ALTER TABLE returns ADD COLUMN tax_rate ${RATE}, ADD COLUMN tax_amount ${AMOUNT};
    ALTER TABLE exchanges ADD COLUMN tax_rate ${RATE}, ADD COLUMN tax_amount ${AMOUNT};
    ALTER TABLE orders ALTER COLUMN tax_rate SET DEFAULT 0;

    -- A correction of the rate recorded, not of any amount: the closed-day
    -- guard (which looks at today, not at the order's day) is lifted for it alone.
    ALTER TABLE orders DISABLE TRIGGER orders_refuse_closed_day;
    UPDATE orders SET tax_rate = 0 WHERE tax_amount = 0 AND tax_rate <> 0;
    ALTER TABLE orders ENABLE TRIGGER orders_refuse_closed_day;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE orders ALTER COLUMN tax_rate SET DEFAULT 0.10;
    ALTER TABLE exchanges DROP COLUMN tax_amount, DROP COLUMN tax_rate;
    ALTER TABLE returns DROP COLUMN tax_amount, DROP COLUMN tax_rate;
    ALTER TABLE transactions DROP COLUMN tax_rate;
    DELETE FROM system_config WHERE key IN ('tax_enabled', 'tax_rate_pct', 'tax_name');
  `);
};
