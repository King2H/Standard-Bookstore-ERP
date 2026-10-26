'use strict';

// Services after the sale (#169 PR 3, owner decisions 3a, 4a, 2026-10-26).
//
// A fee goes back through Returns, like a book: a binding cancelled while
// still Requested gives its whole fee back (3a), and a bound copy brought
// back defective gives back its share of the fee with the book (4a). Each is
// a row here, on the return that refunded it: the copies, the amount, and
// the standard cost taken back off the sale's cost (all of it for a binding
// never done; none for a defective one, whose cost stays a loss).
//
// A job whose bound copies all came back is Returned.

exports.shorthands = undefined;

const TENANT = `NULLIF(current_setting('app.tenant_id', true), '')::integer`;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE return_service_lines (
      id bigserial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      return_id bigint NOT NULL REFERENCES returns(id),
      service_line_id bigint NOT NULL REFERENCES sale_service_lines(id),
      quantity integer NOT NULL CHECK (quantity > 0),
      amount numeric(14,2) NOT NULL CHECK (amount >= 0),
      cost_reversed numeric(14,2) NOT NULL CHECK (cost_reversed >= 0),
      kind text NOT NULL CHECK (kind IN ('CANCELLED', 'DEFECT')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX return_service_lines_return ON return_service_lines (return_id);
    CREATE INDEX return_service_lines_service_line ON return_service_lines (service_line_id);

    ALTER TABLE return_service_lines ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON return_service_lines USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});

    ALTER TABLE service_jobs DROP CONSTRAINT service_jobs_status_check;
    ALTER TABLE service_jobs ADD CONSTRAINT service_jobs_status_check
      CHECK (status IN ('REQUESTED', 'AT_BINDER', 'READY', 'COLLECTED', 'CANCELLED', 'RETURNED'));
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE service_jobs DROP CONSTRAINT service_jobs_status_check;
    ALTER TABLE service_jobs ADD CONSTRAINT service_jobs_status_check
      CHECK (status IN ('REQUESTED', 'AT_BINDER', 'READY', 'COLLECTED', 'CANCELLED'));
    DROP TABLE IF EXISTS return_service_lines;
  `);
};
