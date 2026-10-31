'use strict';

// Part-deliveries of an order (#174, owner decision 2a, 2026-10-31).
//
// An order is handed over in one or more deliveries, numbered DLV- by the
// shop's daily counter. Each names, per line of the order, the copies handed
// over. Until every copy is delivered the order is PART_DELIVERED; then it is
// completed as before. Orders delivered before this migration have no
// delivery rows: their lines' qty_fulfilled stays the record.

exports.shorthands = undefined;

const TENANT = `NULLIF(current_setting('app.tenant_id', true), '')::integer`;

const STATUSES = [
  'Pending', 'Confirmed', 'In_Progress', 'Fulfilled', 'Cancelled',
  'DRAFT', 'CONFIRMED', 'PAID', 'FULFILLED', 'COMPLETED', 'CANCELLED',
];

const statusCheck = (values) => `
  ALTER TABLE orders DROP CONSTRAINT orders_status_check;
  ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (${values.map((v) => `'${v}'`).join(', ')}));
`;

exports.up = function (pgm) {
  pgm.sql(`
    ${statusCheck([...STATUSES, 'PART_DELIVERED'])}

    CREATE TABLE order_deliveries (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      delivery_number text NOT NULL,
      -- Part of the order: an order is deleted only without stock history, so never with deliveries.
      order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      delivered_by integer NOT NULL REFERENCES staff(id),
      delivered_at timestamptz NOT NULL DEFAULT now(),
      notes text,
      CONSTRAINT order_deliveries_number_key UNIQUE (tenant_id, delivery_number)
    );
    CREATE INDEX order_deliveries_order_idx ON order_deliveries (order_id, id);

    CREATE TABLE order_delivery_lines (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      delivery_id integer NOT NULL REFERENCES order_deliveries(id) ON DELETE CASCADE,
      order_line_item_id bigint NOT NULL REFERENCES order_line_items(id) ON DELETE CASCADE,
      quantity integer NOT NULL CHECK (quantity > 0),
      CONSTRAINT order_delivery_lines_key UNIQUE (delivery_id, order_line_item_id)
    );
    CREATE INDEX order_delivery_lines_line_idx ON order_delivery_lines (order_line_item_id);

    ALTER TABLE order_deliveries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON order_deliveries USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
    ALTER TABLE order_delivery_lines ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON order_delivery_lines USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
  `);
};

exports.down = function (pgm) {
  // A part-delivered order has no status to go back to: rolling back is refused.
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM orders WHERE status = 'PART_DELIVERED') THEN
        RAISE EXCEPTION 'Orders are part-delivered; this migration cannot be rolled back';
      END IF;
    END $$;
    DROP TABLE IF EXISTS order_delivery_lines;
    DROP TABLE IF EXISTS order_deliveries;
    ${statusCheck(STATUSES)}
  `);
};
