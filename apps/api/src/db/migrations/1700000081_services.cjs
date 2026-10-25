'use strict';

// The services list (#169 PR 1, owner decisions 1a, 2a, 3a, 4a, 2026-10-25).
//
// Services are non-stock items a sale carries next to its books; binding is
// the first kind: the shop binds a copy it sells in the cover the service
// names (a book format). Each has a code typed by staff, unique in the shop
// ignoring case; a fee, which a branch may override (2a); a standard cost,
// one for the whole shop; whether the fee may be discounted; a turnaround in
// days; and the catalog's lifecycle status.
//
// Both tables belong to a tenant under row-level security, like every
// business table (ADR-0003, 1700000070).

exports.shorthands = undefined;

const TENANT = `NULLIF(current_setting('app.tenant_id', true), '')::integer`;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE services (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      code text NOT NULL CHECK (code = upper(btrim(code)) AND code <> ''),
      name text NOT NULL CHECK (btrim(name) <> ''),
      kind text NOT NULL DEFAULT 'binding' CHECK (kind IN ('binding')),
      format_id integer REFERENCES book_formats(id),
      fee numeric(14,2) NOT NULL CHECK (fee > 0),
      standard_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (standard_cost >= 0),
      discountable boolean NOT NULL DEFAULT false,
      turnaround_days integer NOT NULL DEFAULT 0 CHECK (turnaround_days >= 0),
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
      created_by integer REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_by integer REFERENCES staff(id),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT services_binding_has_cover CHECK (kind <> 'binding' OR format_id IS NOT NULL),
      CONSTRAINT services_code_key UNIQUE (tenant_id, code)
    );

    CREATE TABLE service_branch_fees (
      service_id integer NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      branch_id integer NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      fee numeric(14,2) NOT NULL CHECK (fee > 0),
      updated_by integer REFERENCES staff(id),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (service_id, branch_id)
    );
    CREATE INDEX service_branch_fees_branch_idx ON service_branch_fees (branch_id);

    ALTER TABLE services ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON services USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
    ALTER TABLE service_branch_fees ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON service_branch_fees USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS service_branch_fees;
    DROP TABLE IF EXISTS services;
  `);
};
