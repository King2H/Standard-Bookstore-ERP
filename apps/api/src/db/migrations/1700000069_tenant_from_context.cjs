'use strict';

// Tenancy, part 2 (#13): a new row belongs to the tenant of the work that
// writes it. The application hands every connection that tenant as
// app.tenant_id (a request's signed-in account, a background job's tenant);
// the tenant_id default reads it instead of assuming tenant 1. A write with
// no tenant now fails on the NOT NULL instead of landing in tenant 1.

exports.shorthands = undefined;

const FOR_EACH_TENANT_TABLE = (statement) => `
  DO $$
  DECLARE t text;
  BEGIN
    FOR t IN
      SELECT c.relname FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    LOOP
      EXECUTE format(${statement}, t);
    END LOOP;
  END $$;
`;

exports.up = function (pgm) {
  pgm.sql(FOR_EACH_TENANT_TABLE(
    `'ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT NULLIF(current_setting(''app.tenant_id'', true), '''')::integer'`,
  ));
};

exports.down = function (pgm) {
  pgm.sql(FOR_EACH_TENANT_TABLE(`'ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT 1'`));
};
