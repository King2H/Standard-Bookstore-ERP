'use strict';

// Records carry the shop's currency (#181, owner decisions 1a, 2a, 3a,
// 2026-10-24).
//
// Every record stored a fixed ETB: the code named it, or the column defaulted
// to it, and purchase orders and bank accounts were checked to be ETB. Now the
// API names the shop's currency on every insert, so the columns lose their
// default (an insert that names none is refused) and the ETB checks give way
// to a three-letter code check (1a).
//
// Records made before are put in their shop's currency (2a). The currency
// changes only while nothing is kept in it and amounts are never converted,
// so a shop's records were always meant to be in its one currency. Each shop
// with a record changed gets one audit entry counting them.
//
// A fresh install came with two sample draft purchase orders, which would
// now hold the currency (3a). Where one is still an untouched draft (no audit
// entry, so never edited, submitted or cancelled), it is removed, audited
// (owner decision, 2026-10-24). New installs lose them the same way.
//
// Running it again changes nothing. The down migration puts the defaults and
// ETB checks back (not checked against existing rows) and leaves the records
// as they are.

exports.shorthands = undefined;

const TABLES = [
  'transactions',
  'orders',
  'order_payments',
  'receivables',
  'financial_transactions',
  'exchanges',
  'exchange_settlement_entries',
  'installment_plans',
  'purchase_orders',
  'bank_accounts',
];

exports.up = function (pgm) {
  pgm.sql(`
    WITH samples AS (
      SELECT po.id, po.tenant_id, po.branch_id, po.notes, po.total_amount, po.currency
      FROM purchase_orders po
      WHERE po.status = 'draft'
        AND po.notes IN ('Sample PO 1 (seed)', 'Sample PO 2 (seed)')
        AND NOT EXISTS (
          SELECT 1 FROM audit_logs a
          WHERE a.tenant_id = po.tenant_id AND a.entity_type = 'purchase_order' AND a.entity_id = po.id::text
        )
        AND NOT EXISTS (SELECT 1 FROM po_receipts r WHERE r.po_id = po.id)
        AND NOT EXISTS (SELECT 1 FROM supplier_payments p WHERE p.po_id = po.id)
        AND NOT EXISTS (SELECT 1 FROM supplier_credit_notes n WHERE n.po_id = po.id)
    ),
    -- Its lines go with it (ON DELETE CASCADE).
    removed AS (
      DELETE FROM purchase_orders WHERE id IN (SELECT id FROM samples)
      RETURNING id
    )
    INSERT INTO audit_logs (tenant_id, staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
    SELECT s.tenant_id, NULL, 'system', 'DELETE', 'purchase_order', s.id::text, s.branch_id,
           jsonb_build_object(
             'notes', s.notes,
             'totalAmount', s.total_amount,
             'currency', s.currency,
             'reason', 'Sample draft of a fresh install, never touched; it would hold the shop''s currency'
           )
    FROM samples s JOIN removed r ON r.id = s.id
    ORDER BY s.id;
  `);

  for (const table of TABLES) {
    pgm.sql(`
      ALTER TABLE ${table}
        ALTER COLUMN currency DROP DEFAULT,
        DROP CONSTRAINT IF EXISTS ${table}_currency_etb,
        DROP CONSTRAINT IF EXISTS ${table}_currency_code;
    `);
  }

  // One statement, so each shop's changes are counted for its audit entry.
  const restamps = TABLES.map(
    (table) => `
    ${table} AS (
      UPDATE ${table} t SET currency = s.currency
      FROM shops s
      WHERE t.tenant_id = s.tenant_id AND t.currency <> s.currency
      RETURNING t.tenant_id, '${table}' AS tbl
    )`,
  ).join(',');
  pgm.sql(`
    WITH shops AS (
      SELECT tenant_id, value #>> '{}' AS currency
      FROM system_config
      WHERE key = 'base_currency' AND jsonb_typeof(value) = 'string' AND value #>> '{}' ~ '^[A-Z]{3}$'
    ),
    ${restamps},
    changed AS (
      ${TABLES.map((table) => `SELECT tenant_id, tbl FROM ${table}`).join(' UNION ALL ')}
    ),
    counted AS (
      SELECT tenant_id, jsonb_object_agg(tbl, n ORDER BY tbl) AS records
      FROM (SELECT tenant_id, tbl, COUNT(*)::int AS n FROM changed GROUP BY tenant_id, tbl) c
      GROUP BY tenant_id
    )
    INSERT INTO audit_logs (tenant_id, staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
    SELECT c.tenant_id, NULL, 'system', 'UPDATE', 'system_config', 'base_currency', NULL,
           jsonb_build_object(
             'currency', s.currency,
             'records', c.records,
             'reason', 'Records were stored in ETB whatever the shop''s currency; amounts are not converted'
           )
    FROM counted c JOIN shops s ON s.tenant_id = c.tenant_id;
  `);

  for (const table of TABLES) {
    pgm.sql(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_currency_code CHECK (currency ~ '^[A-Z]{3}$');`);
  }
};

exports.down = function (pgm) {
  for (const table of TABLES) {
    pgm.sql(`
      ALTER TABLE ${table}
        DROP CONSTRAINT IF EXISTS ${table}_currency_code,
        ALTER COLUMN currency SET DEFAULT 'ETB';
    `);
  }
  pgm.sql(`ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_currency_etb CHECK (currency = 'ETB') NOT VALID;`);
  pgm.sql(`ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_currency_etb CHECK (currency = 'ETB') NOT VALID;`);
};
