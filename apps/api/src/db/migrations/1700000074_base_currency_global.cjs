'use strict';

// The shop's currency is one setting for every branch.
//
// A fresh install started in USD: 1700000004 seeded base_currency as "USD",
// and the "ETB" of 1700000031 and of the startup seed was never written over
// it. Every amount the system records is kept in ETB, so where the currency is
// still that seeded USD (never changed in Settings, which audits each change),
// it becomes ETB. A currency someone chose is left as it is.
//
// A branch could override the currency and show its amounts under another
// one. The API now refuses that override; the ones already saved are removed.
//
// Each change is written to the audit log. Running it again changes nothing.
// No schema change. The down migration leaves the currency as corrected.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    WITH seeded AS (
      UPDATE system_config sc
         SET value = '"ETB"'::jsonb, updated_at = now()
       WHERE sc.key = 'base_currency' AND sc.value = '"USD"'::jsonb
         AND NOT EXISTS (
           SELECT 1 FROM audit_logs a
           WHERE a.tenant_id = sc.tenant_id AND a.entity_type = 'system_config' AND a.entity_id = 'base_currency'
         )
      RETURNING sc.tenant_id
    )
    INSERT INTO audit_logs (tenant_id, staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
    SELECT tenant_id, NULL, 'system', 'UPDATE', 'system_config', 'base_currency', NULL,
           jsonb_build_object(
             'key', 'base_currency',
             'previousValue', 'USD',
             'newValue', 'ETB',
             'reason', 'Fresh installs started in USD while every amount is recorded in ETB'
           )
    FROM seeded;
  `);

  pgm.sql(`
    WITH removed AS (
      DELETE FROM branch_config WHERE key = 'base_currency'
      RETURNING tenant_id, branch_id, value
    )
    INSERT INTO audit_logs (tenant_id, staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
    SELECT tenant_id, NULL, 'system', 'DELETE', 'branch_config', 'base_currency', branch_id,
           jsonb_build_object(
             'key', 'base_currency',
             'branchId', branch_id,
             'action', 'override_removed',
             'previousValue', value,
             'reason', 'The currency is one setting for every branch'
           )
    FROM removed;
  `);
};

exports.down = function () {};
