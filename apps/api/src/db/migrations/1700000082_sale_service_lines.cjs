'use strict';

// Services on a sale (#169 PR 2, owner decisions 1a, 2a, 3a, 4a, 5a, 6a, 2026-10-25).
//
// A service line hangs off one book line, of a counter sale or of an order
// (1a), for some or all of its copies (2a). It keeps what was charged at the
// sale: the fee, its discount, the line total, and the service's standard
// cost. The book-line tables are left as they are, so stock, cost, returns
// and the existing reports read them unchanged.
//
// Each service line has one job, opened at the sale, or at confirmation for
// an order (5a): numbered SVC-YYYYMMDD-NNNN, for a named customer, with a
// ready date, moved Requested -> At binder -> Ready -> Collected, or
// Cancelled when its sale is voided or cancelled (4a).
//
// Both tables belong to a tenant under row-level security (ADR-0003).

exports.shorthands = undefined;

const TENANT = `NULLIF(current_setting('app.tenant_id', true), '')::integer`;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE sale_service_lines (
      id bigserial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      transaction_line_item_id bigint REFERENCES transaction_line_items(id) ON DELETE CASCADE,
      order_line_item_id bigint REFERENCES order_line_items(id) ON DELETE CASCADE,
      service_id integer NOT NULL REFERENCES services(id),
      quantity integer NOT NULL CHECK (quantity > 0),
      unit_fee numeric(14,2) NOT NULL CHECK (unit_fee > 0),
      discount_pct numeric(7,4) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
      discount_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
      line_total numeric(14,2) NOT NULL CHECK (line_total >= 0),
      standard_cost numeric(14,2) NOT NULL CHECK (standard_cost >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sale_service_lines_one_sale CHECK (num_nonnulls(transaction_line_item_id, order_line_item_id) = 1),
      CONSTRAINT sale_service_lines_total CHECK (line_total = unit_fee * quantity - discount_amount)
    );
    CREATE UNIQUE INDEX sale_service_lines_pos_line ON sale_service_lines (transaction_line_item_id) WHERE transaction_line_item_id IS NOT NULL;
    CREATE UNIQUE INDEX sale_service_lines_order_line ON sale_service_lines (order_line_item_id) WHERE order_line_item_id IS NOT NULL;
    CREATE INDEX sale_service_lines_service ON sale_service_lines (service_id);

    CREATE TABLE service_jobs (
      id bigserial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      service_line_id bigint NOT NULL UNIQUE REFERENCES sale_service_lines(id),
      branch_id integer NOT NULL REFERENCES branches(id),
      customer_id integer NOT NULL REFERENCES customers(id),
      job_number text NOT NULL,
      status text NOT NULL DEFAULT 'REQUESTED'
        CHECK (status IN ('REQUESTED', 'AT_BINDER', 'READY', 'COLLECTED', 'CANCELLED')),
      ready_date date NOT NULL,
      created_by integer REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_by integer REFERENCES staff(id),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT service_jobs_number_key UNIQUE (tenant_id, job_number)
    );
    CREATE INDEX service_jobs_branch_status ON service_jobs (branch_id, status);

    ALTER TABLE sale_service_lines ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON sale_service_lines USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
    ALTER TABLE service_jobs ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON service_jobs USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS service_jobs;
    DROP TABLE IF EXISTS sale_service_lines;
  `);
};
