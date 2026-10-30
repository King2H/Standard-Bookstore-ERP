'use strict';

// Returns to supplier (#173, owner decisions 1a–6a, 2026-10-30).
//
// Books going back to a supplier against a purchase order, numbered RTS- by
// the shop's daily counter: Draft, then Sent or Cancelled. Each line names a
// line of the order, a location of the receiving branch and whether the
// copies come from stock for sale or from damaged copies; it keeps the
// order's price (what the supplier credits) and, once sent, the cost the
// copies left at. Sending creates a credit note at the order's price, kept on
// the return. What the order then owes below zero is a refund due from the
// supplier: the money coming back is a supplier refund, numbered SREF-.

exports.shorthands = undefined;

const TENANT = `NULLIF(current_setting('app.tenant_id', true), '')::integer`;

const REFERENCE_TYPES = [
  'purchase_order', 'return', 'adjustment', 'manual', 'initial_stock',
  'sale', 'void', 'pos_return', 'order',
  'exchange_in', 'exchange_out', 'exchange_damaged',
  'order_confirmed', 'order_cancelled',
  'order_fulfilled', 'order_return',
  'transfer', 'customer_exchange', 'branch_transfer', 'stock_count',
];

const BANK_SOURCES = [
  'order_payment', 'order_refund', 'receivable_payment', 'pos_payment', 'pos_void',
  'return_refund', 'exchange_payment', 'exchange_void', 'supplier_payment',
];

const list = (values) => values.map((v) => `'${v}'`).join(', ');

const checks = (references, sources) => `
  ALTER TABLE inventory_history DROP CONSTRAINT inventory_history_reference_type_check;
  ALTER TABLE inventory_history ADD CONSTRAINT inventory_history_reference_type_check
    CHECK (reference_type IS NULL OR reference_type IN (${list(references)}));
  ALTER TABLE bank_reconciliation DROP CONSTRAINT bank_reconciliation_source_type_check;
  ALTER TABLE bank_reconciliation ADD CONSTRAINT bank_reconciliation_source_type_check
    CHECK (source_type IN (${list(sources)}));
`;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE supplier_returns (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      return_number text NOT NULL,
      po_id bigint NOT NULL REFERENCES purchase_orders(id),
      -- The receiving branch: the copies leave from there.
      branch_id integer NOT NULL REFERENCES branches(id),
      supplier_id integer NOT NULL REFERENCES suppliers(id),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'cancelled')),
      notes text,
      created_by integer NOT NULL REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      sent_by integer REFERENCES staff(id),
      sent_at timestamptz,
      credit_note_id integer REFERENCES supplier_credit_notes(id),
      cancelled_by integer REFERENCES staff(id),
      cancelled_at timestamptz,
      cancel_reason text,
      CONSTRAINT supplier_returns_sent CHECK ((status = 'sent') = (sent_at IS NOT NULL) AND (sent_at IS NULL) = (sent_by IS NULL)),
      CONSTRAINT supplier_returns_cancelled CHECK (
        (status = 'cancelled') = (cancelled_at IS NOT NULL)
        AND (cancelled_at IS NULL OR (cancelled_by IS NOT NULL AND btrim(coalesce(cancel_reason, '')) <> ''))
      ),
      CONSTRAINT supplier_returns_number_key UNIQUE (tenant_id, return_number)
    );
    CREATE INDEX supplier_returns_po_idx ON supplier_returns (po_id);
    CREATE INDEX supplier_returns_branch_idx ON supplier_returns (branch_id, created_at DESC);

    CREATE TABLE supplier_return_lines (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      return_id integer NOT NULL REFERENCES supplier_returns(id) ON DELETE CASCADE,
      po_line_item_id bigint NOT NULL REFERENCES po_line_items(id),
      book_id integer NOT NULL REFERENCES books(id),
      location_id integer NOT NULL REFERENCES locations(id),
      source text NOT NULL CHECK (source IN ('stock', 'damaged')),
      quantity integer NOT NULL CHECK (quantity > 0),
      -- The order's price: what the supplier credits for each copy.
      unit_credit numeric(14,4) NOT NULL CHECK (unit_credit >= 0),
      -- What each copy cost when it left; set when the return is sent.
      unit_cost numeric(14,4) CHECK (unit_cost >= 0),
      CONSTRAINT supplier_return_lines_key UNIQUE (return_id, po_line_item_id, location_id, source)
    );

    CREATE TABLE supplier_refunds (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      refund_number text NOT NULL,
      po_id bigint NOT NULL REFERENCES purchase_orders(id),
      -- The ordering branch, which pays and is paid back.
      branch_id integer NOT NULL REFERENCES branches(id),
      supplier_id integer NOT NULL REFERENCES suppliers(id),
      amount numeric(14,2) NOT NULL CHECK (amount > 0),
      refund_method text NOT NULL CHECK (refund_method IN ('cash', 'bank', 'mobile', 'cheque')),
      reference text,
      bank_account_id integer REFERENCES bank_accounts(id),
      notes text,
      created_by integer NOT NULL REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT supplier_refunds_number_key UNIQUE (tenant_id, refund_number)
    );
    CREATE INDEX supplier_refunds_po_idx ON supplier_refunds (po_id);

    ALTER TABLE supplier_returns ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON supplier_returns USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
    ALTER TABLE supplier_return_lines ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON supplier_return_lines USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
    ALTER TABLE supplier_refunds ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON supplier_refunds USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});

    ${checks([...REFERENCE_TYPES, 'supplier_return'], [...BANK_SOURCES, 'supplier_refund'])}
  `);
};

exports.down = function (pgm) {
  // Stock and money moved by a sent return keep their record: rolling back
  // after that would leave them with no explanation, so it is refused.
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM supplier_returns WHERE status = 'sent') OR EXISTS (SELECT 1 FROM supplier_refunds) THEN
        RAISE EXCEPTION 'Books or money have gone back to suppliers; this migration cannot be rolled back';
      END IF;
    END $$;
    ${checks(REFERENCE_TYPES, BANK_SOURCES)}
    DROP TABLE IF EXISTS supplier_refunds;
    DROP TABLE IF EXISTS supplier_return_lines;
    DROP TABLE IF EXISTS supplier_returns;
  `);
};
