'use strict';

// Day and month close (#175, owner decisions 1a–6a, 2026-10-31).
//
// 1a: the shop works in its local time zone, the business_timezone setting
// (Africa/Addis_Ababa unless changed). Every connection is set to it when the
// API checks it out (apply_tenant), so DATE(), CURRENT_DATE and dates given
// to reports are the shop's local days.
//
// 2a, 3a: a branch's closed day keeps its report (DAY-). From then on nothing
// is recorded in that branch on that day: the ledger tables refuse any row
// written, changed or removed in a branch whose current local day is closed
// (refuse_closed_day). Writes are always dated when they happen, so that is
// every write that could land on a closed day; the in-place changes of an
// earlier day (voiding a sale or exchange, reversing a supplier payment) are
// refused by their services. A close waits for the writes already under way
// in the branch, and writes that start during it wait for the close: they
// take the branch's day lock shared, the close takes it alone.
//
// 4a, 5a: a closed month (business_months) keeps its summary and locks every
// day in it, including days a branch did not work; reopening is an Admin's,
// with a reason.

exports.shorthands = undefined;

const TENANT = `NULLIF(current_setting('app.tenant_id', true), '')::integer`;

/** The ledger tables and how each finds its branch: its own column, or the row it belongs to. */
const GUARDED = [
  ['transactions', 'branch_id', null],
  ['transaction_payments', 'transaction_id', 'transactions'],
  ['orders', 'branch_id', null],
  ['order_payments', 'order_id', 'orders'],
  ['order_refunds', 'order_id', 'orders'],
  ['order_deliveries', 'order_id', 'orders'],
  ['returns', 'branch_id', null],
  ['refunds', 'return_id', 'returns'],
  ['exchanges', 'branch_id', null],
  ['exchange_settlement_entries', 'exchange_id', 'exchanges'],
  ['inventory_history', 'location_id', 'locations'],
  ['po_receipts', 'location_id', 'locations'],
  ['cash_sessions', 'branch_id', null],
  ['cash_session_movements', 'session_id', 'cash_sessions'],
  ['financial_transactions', 'branch_id', null],
  ['supplier_payments', 'branch_id', null],
  ['supplier_refunds', 'branch_id', null],
  ['supplier_credit_notes', 'branch_id', null],
];

exports.up = function (pgm) {
  pgm.sql(`
    -- The shop's time zone. Its value is checked when it is set.
    CREATE FUNCTION business_timezone(tenant integer) RETURNS text LANGUAGE sql STABLE AS $$
      SELECT COALESCE((SELECT value #>> '{}' FROM system_config WHERE tenant_id = tenant AND key = 'business_timezone'), 'Africa/Addis_Ababa')
    $$;

    -- Called on every checkout: the work's tenant, then its time zone (UTC for work with no tenant). A
    -- zone PostgreSQL does not know falls back to the default rather than stopping every connection.
    CREATE FUNCTION apply_tenant(tenant text) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM set_config('app.tenant_id', tenant, false);
      BEGIN
        PERFORM set_config('TimeZone', CASE WHEN tenant = '' THEN 'UTC' ELSE business_timezone(tenant::integer) END, false);
      EXCEPTION WHEN invalid_parameter_value THEN
        PERFORM set_config('TimeZone', 'Africa/Addis_Ababa', false);
      END;
    END $$;

    CREATE TABLE business_days (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      branch_id integer NOT NULL REFERENCES branches(id),
      day date NOT NULL,
      status text NOT NULL CHECK (status IN ('closed', 'reopened')),
      day_number text NOT NULL,
      report jsonb NOT NULL,
      closed_by integer NOT NULL REFERENCES staff(id),
      closed_at timestamptz NOT NULL DEFAULT now(),
      reopened_by integer REFERENCES staff(id),
      reopened_at timestamptz,
      reopen_reason text,
      CONSTRAINT business_days_reopened CHECK (
        (status = 'reopened') = (reopened_at IS NOT NULL)
        AND (reopened_at IS NULL) = (reopened_by IS NULL)
        AND (reopened_at IS NULL OR btrim(coalesce(reopen_reason, '')) <> '')
      ),
      CONSTRAINT business_days_branch_day_key UNIQUE (branch_id, day),
      CONSTRAINT business_days_day_number_key UNIQUE (tenant_id, day_number)
    );

    CREATE TABLE business_months (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      month date NOT NULL CHECK (extract(day FROM month) = 1),
      status text NOT NULL CHECK (status IN ('closed', 'reopened')),
      summary jsonb NOT NULL,
      closed_by integer NOT NULL REFERENCES staff(id),
      closed_at timestamptz NOT NULL DEFAULT now(),
      reopened_by integer REFERENCES staff(id),
      reopened_at timestamptz,
      reopen_reason text,
      CONSTRAINT business_months_reopened CHECK (
        (status = 'reopened') = (reopened_at IS NOT NULL)
        AND (reopened_at IS NULL) = (reopened_by IS NULL)
        AND (reopened_at IS NULL OR btrim(coalesce(reopen_reason, '')) <> '')
      ),
      CONSTRAINT business_months_month_key UNIQUE (tenant_id, month)
    );

    ALTER TABLE business_days ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON business_days USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
    ALTER TABLE business_months ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON business_months USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});

    -- 'month' when the day's month is closed, 'day' when the branch's day is, else null.
    CREATE FUNCTION closed_period(branch integer, d date) RETURNS text LANGUAGE sql STABLE AS $$
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM business_months m JOIN branches b ON b.tenant_id = m.tenant_id
                     WHERE b.id = branch AND m.month = date_trunc('month', d)::date AND m.status = 'closed') THEN 'month'
        WHEN EXISTS (SELECT 1 FROM business_days bd WHERE bd.branch_id = branch AND bd.day = d AND bd.status = 'closed') THEN 'day'
      END
    $$;

    -- The day lock of a branch: writes hold it shared, a close alone.
    CREATE FUNCTION lock_business_day(branch integer, exclusive boolean) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF exclusive THEN PERFORM pg_advisory_xact_lock(175, branch);
      ELSE PERFORM pg_advisory_xact_lock_shared(175, branch);
      END IF;
    END $$;

    -- Arguments: the column naming the branch, or the row (column, table) whose branch it is.
    CREATE FUNCTION refuse_closed_day() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      r jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
      branch integer;
      tenant integer := (r->>'tenant_id')::integer;
      today date;
      closed text;
    BEGIN
      IF TG_NARGS = 1 THEN
        branch := (r->>TG_ARGV[0])::integer;
      ELSE
        EXECUTE format('SELECT branch_id FROM %I WHERE id = $1', TG_ARGV[1]) INTO branch USING (r->>TG_ARGV[0])::bigint;
      END IF;
      IF branch IS NULL THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END IF;
      PERFORM lock_business_day(branch, false);
      -- The API's connections are in the shop's time zone already; others (fixtures, the demo loader) are not.
      today := CASE WHEN current_setting('app.tenant_id', true) = tenant::text THEN current_date
                    ELSE (now() AT TIME ZONE business_timezone(tenant))::date END;
      closed := closed_period(branch, today);
      IF closed = 'month' THEN
        RAISE EXCEPTION 'The month of % is closed', today USING ERRCODE = 'BD002', DETAIL = today::text;
      ELSIF closed = 'day' THEN
        RAISE EXCEPTION 'The day % is closed in branch %', today, branch USING ERRCODE = 'BD001', DETAIL = today::text;
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END $$;
  `);

  for (const [table, column, parent] of GUARDED) {
    const args = parent ? `'${column}', '${parent}'` : `'${column}'`;
    pgm.sql(`
      CREATE TRIGGER ${table}_refuse_closed_day BEFORE INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION refuse_closed_day(${args});
    `);
  }

  pgm.sql(`
    INSERT INTO system_config (tenant_id, key, value, updated_by)
    SELECT t.id, 'business_timezone', '"Africa/Addis_Ababa"'::jsonb, COALESCE((SELECT MIN(s.id) FROM staff s WHERE s.tenant_id = t.id), 1)
    FROM tenants t
    ON CONFLICT (tenant_id, key) DO NOTHING;
  `);
};

exports.down = function (pgm) {
  for (const [table] of GUARDED) {
    pgm.sql(`DROP TRIGGER IF EXISTS ${table}_refuse_closed_day ON ${table};`);
  }
  pgm.sql(`
    DELETE FROM system_config WHERE key = 'business_timezone';
    DROP FUNCTION IF EXISTS refuse_closed_day();
    DROP FUNCTION IF EXISTS lock_business_day(integer, boolean);
    DROP FUNCTION IF EXISTS closed_period(integer, date);
    DROP TABLE IF EXISTS business_months;
    DROP TABLE IF EXISTS business_days;
    DROP FUNCTION IF EXISTS apply_tenant(text);
    DROP FUNCTION IF EXISTS business_timezone(integer);
  `);
};
