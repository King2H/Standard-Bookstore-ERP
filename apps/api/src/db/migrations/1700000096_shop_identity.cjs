'use strict';

// The shop's identity (#228, owner decisions 1a–4a, 2026-11-04).
//
// The shop's name, motto and TIN head every receipt and slip and the welcome
// banner, which named one shop for every shop. They are shop-wide settings,
// set by Super_Admin. Every install starts with them empty (4a): none shows a
// name it did not choose.

exports.shorthands = undefined;

const KEYS = ['shop_name', 'shop_motto', 'shop_tin'];

exports.up = function (pgm) {
  pgm.sql(`
    INSERT INTO system_config (tenant_id, key, value, updated_by)
    SELECT t.id, k.key, '""'::jsonb, COALESCE((SELECT MIN(s.id) FROM staff s WHERE s.tenant_id = t.id), 1)
    FROM tenants t CROSS JOIN unnest(ARRAY[${KEYS.map((k) => `'${k}'`).join(', ')}]) AS k(key)
    ON CONFLICT (tenant_id, key) DO NOTHING;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`DELETE FROM system_config WHERE key IN (${KEYS.map((k) => `'${k}'`).join(', ')});`);
};
