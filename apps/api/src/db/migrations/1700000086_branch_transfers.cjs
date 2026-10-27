'use strict';

// Transfers between branches (#170, owner decisions 1a–6a, 2026-10-26).
//
// A transfer note moves books from a location of the sending branch to the
// receiving branch: drafted, dispatched (the copies leave at the source's
// average cost, kept on the line, and are in transit), then received line by
// line. What does not arrive is resolved with a reason: lost, damaged or
// returned to the sender. Each receipt and resolution is an event; the line
// keeps the running counts, which never exceed what was sent. Numbered TRF-
// by the shop's daily counter.
//
// The stock history names the note as reference type 'branch_transfer'.

exports.shorthands = undefined;

const TENANT = `NULLIF(current_setting('app.tenant_id', true), '')::integer`;

const REFERENCE_TYPES = [
  'purchase_order', 'return', 'adjustment', 'manual', 'initial_stock',
  'sale', 'void', 'pos_return', 'order',
  'exchange_in', 'exchange_out', 'exchange_damaged',
  'order_confirmed', 'order_cancelled',
  'order_fulfilled', 'order_return',
  'transfer', 'customer_exchange',
];

const referenceCheck = (types) => `
  ALTER TABLE inventory_history DROP CONSTRAINT inventory_history_reference_type_check;
  ALTER TABLE inventory_history ADD CONSTRAINT inventory_history_reference_type_check
    CHECK (reference_type IS NULL OR reference_type IN (${types.map((t) => `'${t}'`).join(', ')}));
`;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE branch_transfers (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      transfer_number text NOT NULL,
      from_branch_id integer NOT NULL REFERENCES branches(id),
      from_location_id integer NOT NULL REFERENCES locations(id),
      to_branch_id integer NOT NULL REFERENCES branches(id),
      status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'in_transit', 'partially_received', 'received', 'closed', 'cancelled')),
      notes text,
      created_by integer NOT NULL REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      dispatched_by integer REFERENCES staff(id),
      dispatched_at timestamptz,
      cancelled_by integer REFERENCES staff(id),
      cancelled_at timestamptz,
      completed_at timestamptz,
      CONSTRAINT branch_transfers_two_branches CHECK (from_branch_id <> to_branch_id),
      CONSTRAINT branch_transfers_dispatched CHECK ((status IN ('draft', 'cancelled')) = (dispatched_at IS NULL)),
      CONSTRAINT branch_transfers_number_key UNIQUE (tenant_id, transfer_number)
    );
    CREATE INDEX branch_transfers_from_idx ON branch_transfers (from_branch_id, created_at DESC);
    CREATE INDEX branch_transfers_to_idx ON branch_transfers (to_branch_id, created_at DESC);

    CREATE TABLE branch_transfer_lines (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      transfer_id integer NOT NULL REFERENCES branch_transfers(id) ON DELETE CASCADE,
      book_id integer NOT NULL REFERENCES books(id),
      quantity integer NOT NULL CHECK (quantity > 0),
      unit_cost numeric(14,4) CHECK (unit_cost >= 0),
      received_quantity integer NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
      lost_quantity integer NOT NULL DEFAULT 0 CHECK (lost_quantity >= 0),
      damaged_quantity integer NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
      returned_quantity integer NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
      CONSTRAINT branch_transfer_lines_within_sent
        CHECK (received_quantity + lost_quantity + damaged_quantity + returned_quantity <= quantity),
      CONSTRAINT branch_transfer_lines_book_key UNIQUE (transfer_id, book_id)
    );

    CREATE TABLE branch_transfer_events (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      transfer_id integer NOT NULL REFERENCES branch_transfers(id) ON DELETE CASCADE,
      line_id integer NOT NULL REFERENCES branch_transfer_lines(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('received', 'lost', 'damaged', 'returned')),
      quantity integer NOT NULL CHECK (quantity > 0),
      location_id integer REFERENCES locations(id),
      reason text,
      staff_id integer NOT NULL REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT branch_transfer_events_reason CHECK (kind = 'received' OR btrim(coalesce(reason, '')) <> ''),
      CONSTRAINT branch_transfer_events_location CHECK ((kind = 'lost') = (location_id IS NULL))
    );
    CREATE INDEX branch_transfer_events_transfer_idx ON branch_transfer_events (transfer_id, id);

    ALTER TABLE branch_transfers ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON branch_transfers USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
    ALTER TABLE branch_transfer_lines ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON branch_transfer_lines USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
    ALTER TABLE branch_transfer_events ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON branch_transfer_events USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});

    ${referenceCheck([...REFERENCE_TYPES, 'branch_transfer'])}
  `);
};

exports.down = function (pgm) {
  // Stock that moved on a transfer note keeps its history: rolling back after
  // that would leave stock with no explanation, so it is refused.
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM inventory_history WHERE reference_type = 'branch_transfer') THEN
        RAISE EXCEPTION 'Stock has moved on transfer notes; this migration cannot be rolled back';
      END IF;
    END $$;
    ${referenceCheck(REFERENCE_TYPES)}
    DROP TABLE IF EXISTS branch_transfer_events;
    DROP TABLE IF EXISTS branch_transfer_lines;
    DROP TABLE IF EXISTS branch_transfers;
  `);
};
