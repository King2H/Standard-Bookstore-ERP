'use strict';

// Stock counts (#172, owner decisions 1a–6a, 2026-10-30).
//
// A stocktake of one location, the whole of it or chosen books, numbered
// CNT- by the shop's daily counter; one open count per location. Each line
// keeps the quantity on hand when the count opened (frozen), and, when the
// book is counted, the quantity counted and the quantity on hand at that
// moment (expected): selling goes on, and a sale during the count is never a
// shortage. Each count of a book is an entry, the last one standing. Posting
// writes one adjustment per difference at the average cost, kept on the
// line, with reason "count" and the stock history naming the count as
// reference type 'stock_count'.

exports.shorthands = undefined;

const TENANT = `NULLIF(current_setting('app.tenant_id', true), '')::integer`;

const REFERENCE_TYPES = [
  'purchase_order', 'return', 'adjustment', 'manual', 'initial_stock',
  'sale', 'void', 'pos_return', 'order',
  'exchange_in', 'exchange_out', 'exchange_damaged',
  'order_confirmed', 'order_cancelled',
  'order_fulfilled', 'order_return',
  'transfer', 'customer_exchange', 'branch_transfer',
];

const referenceCheck = (types) => `
  ALTER TABLE inventory_history DROP CONSTRAINT inventory_history_reference_type_check;
  ALTER TABLE inventory_history ADD CONSTRAINT inventory_history_reference_type_check
    CHECK (reference_type IS NULL OR reference_type IN (${types.map((t) => `'${t}'`).join(', ')}));
`;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE stock_counts (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      count_number text NOT NULL,
      branch_id integer NOT NULL REFERENCES branches(id),
      location_id integer NOT NULL REFERENCES locations(id),
      scope text NOT NULL CHECK (scope IN ('full', 'selected')),
      status text NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'submitted', 'posted', 'cancelled')),
      notes text,
      created_by integer NOT NULL REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      submitted_at timestamptz,
      posted_by integer REFERENCES staff(id),
      posted_at timestamptz,
      cancelled_by integer REFERENCES staff(id),
      cancelled_at timestamptz,
      cancel_reason text,
      CONSTRAINT stock_counts_posted CHECK ((status = 'posted') = (posted_at IS NOT NULL) AND (posted_at IS NULL) = (posted_by IS NULL)),
      CONSTRAINT stock_counts_cancelled CHECK (
        (status = 'cancelled') = (cancelled_at IS NOT NULL)
        AND (cancelled_at IS NULL OR (cancelled_by IS NOT NULL AND btrim(coalesce(cancel_reason, '')) <> ''))
      ),
      CONSTRAINT stock_counts_number_key UNIQUE (tenant_id, count_number)
    );
    CREATE UNIQUE INDEX stock_counts_one_open ON stock_counts (tenant_id, location_id) WHERE status IN ('counting', 'submitted');
    CREATE INDEX stock_counts_branch_idx ON stock_counts (branch_id, created_at DESC);

    CREATE TABLE stock_count_lines (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      count_id integer NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
      book_id integer NOT NULL REFERENCES books(id),
      frozen_quantity integer NOT NULL,
      counted_quantity integer CHECK (counted_quantity >= 0),
      expected_quantity integer,
      counted_by integer REFERENCES staff(id),
      counted_at timestamptz,
      recount_requested boolean NOT NULL DEFAULT false,
      posted_delta integer,
      posted_unit_cost numeric(14,4) CHECK (posted_unit_cost >= 0),
      CONSTRAINT stock_count_lines_counted CHECK ((counted_quantity IS NULL) = (expected_quantity IS NULL)),
      CONSTRAINT stock_count_lines_book_key UNIQUE (count_id, book_id)
    );

    CREATE TABLE stock_count_entries (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      line_id integer NOT NULL REFERENCES stock_count_lines(id) ON DELETE CASCADE,
      quantity integer NOT NULL CHECK (quantity >= 0),
      expected_quantity integer NOT NULL,
      staff_id integer NOT NULL REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX stock_count_entries_line_idx ON stock_count_entries (line_id, id);

    ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON stock_counts USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
    ALTER TABLE stock_count_lines ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON stock_count_lines USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
    ALTER TABLE stock_count_entries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON stock_count_entries USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});

    ${referenceCheck([...REFERENCE_TYPES, 'stock_count'])}
  `);
};

exports.down = function (pgm) {
  // Stock changed by a posted count keeps its history: rolling back after
  // that would leave stock with no explanation, so it is refused.
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM inventory_history WHERE reference_type = 'stock_count') THEN
        RAISE EXCEPTION 'Stock has changed on posted counts; this migration cannot be rolled back';
      END IF;
    END $$;
    ${referenceCheck(REFERENCE_TYPES)}
    DROP TABLE IF EXISTS stock_count_entries;
    DROP TABLE IF EXISTS stock_count_lines;
    DROP TABLE IF EXISTS stock_counts;
  `);
};
