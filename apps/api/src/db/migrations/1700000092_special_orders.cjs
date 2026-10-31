'use strict';

// Special orders (#174, owner decisions 4a and 1a–6a, 2026-10-31).
//
// An order line marked special order is confirmed without stock: its copies
// are on order until they arrive. Purchasers link such a line to a purchase
// order, by the order and not one of its lines, which a draft's edit
// replaces; the book is the line's. When copies of the book arrive on the
// purchase order they are reserved for the linked lines, oldest order first.
// A link is released when its order line is cancelled or the purchase order
// is cancelled or closed; what it had not reserved then arrives as stock.

exports.shorthands = undefined;

const TENANT = `NULLIF(current_setting('app.tenant_id', true), '')::integer`;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE order_line_items ADD COLUMN special_order boolean NOT NULL DEFAULT false;

    CREATE TABLE special_order_links (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      order_line_item_id bigint NOT NULL REFERENCES order_line_items(id) ON DELETE CASCADE,
      po_id bigint NOT NULL REFERENCES purchase_orders(id),
      quantity integer NOT NULL CHECK (quantity > 0),
      -- Copies of this purchase order reserved for the line.
      reserved_quantity integer NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0 AND reserved_quantity <= quantity),
      created_by integer NOT NULL REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      released_at timestamptz,
      CONSTRAINT special_order_links_key UNIQUE (order_line_item_id, po_id)
    );
    CREATE INDEX special_order_links_po_idx ON special_order_links (po_id) WHERE released_at IS NULL;

    ALTER TABLE special_order_links ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON special_order_links USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
  `);
};

exports.down = function (pgm) {
  // Special-order lines would read as ordinary lines short of stock: refused once there are any.
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM order_line_items WHERE special_order) THEN
        RAISE EXCEPTION 'Orders have special-order lines; this migration cannot be rolled back';
      END IF;
    END $$;
    DROP TABLE IF EXISTS special_order_links;
    ALTER TABLE order_line_items DROP COLUMN special_order;
  `);
};
