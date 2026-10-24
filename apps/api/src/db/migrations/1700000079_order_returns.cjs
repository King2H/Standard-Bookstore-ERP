'use strict';

// A delivered customer order is returned through Returns (#166, owner
// decisions 1a, 2a, 3a, 4a, 2026-10-24).
//
// A return names exactly one sale: a counter sale (transaction_id) or a
// customer order (order_id) (1a). Its lines name the sale's line the same
// way. The RET series is shared.
//
// The money of an order return goes back through the order's own payments:
// an order refund carries the return it was made for (return_id), so the
// Payments page and the reports see each refund once.
//
// The return window counts from delivery (3a): orders.fulfilled_at. Orders
// delivered before take the time of their fulfil audit entry, else the time
// they were last changed.
//
// Running it again changes nothing. The down migration fails while an order
// return exists.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE returns ALTER COLUMN transaction_id DROP NOT NULL;
    ALTER TABLE returns ADD COLUMN IF NOT EXISTS order_id bigint REFERENCES orders(id);
    ALTER TABLE returns DROP CONSTRAINT IF EXISTS returns_one_sale;
    ALTER TABLE returns ADD CONSTRAINT returns_one_sale CHECK (num_nonnulls(transaction_id, order_id) = 1);
    CREATE INDEX IF NOT EXISTS returns_order_id_idx ON returns (order_id) WHERE order_id IS NOT NULL;

    ALTER TABLE return_line_items ALTER COLUMN transaction_line_item_id DROP NOT NULL;
    ALTER TABLE return_line_items ADD COLUMN IF NOT EXISTS order_line_item_id bigint REFERENCES order_line_items(id);
    ALTER TABLE return_line_items DROP CONSTRAINT IF EXISTS return_line_items_one_line;
    ALTER TABLE return_line_items ADD CONSTRAINT return_line_items_one_line
      CHECK (num_nonnulls(transaction_line_item_id, order_line_item_id) = 1);
    CREATE INDEX IF NOT EXISTS return_line_items_order_line_item_id_idx
      ON return_line_items (order_line_item_id) WHERE order_line_item_id IS NOT NULL;

    ALTER TABLE order_refunds ADD COLUMN IF NOT EXISTS return_id bigint REFERENCES returns(id);
    CREATE INDEX IF NOT EXISTS order_refunds_return_id_idx ON order_refunds (return_id) WHERE return_id IS NOT NULL;

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;
    UPDATE orders o
       SET fulfilled_at = COALESCE((
             SELECT MAX(a.created_at) FROM audit_logs a
             WHERE a.tenant_id = o.tenant_id AND a.entity_type = 'order' AND a.entity_id = o.id::text
               AND a.meta->>'action' = 'fulfill'), o.updated_at)
     WHERE upper(o.status) IN ('FULFILLED', 'COMPLETED') AND o.fulfilled_at IS NULL;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE orders DROP COLUMN IF EXISTS fulfilled_at;
    DROP INDEX IF EXISTS order_refunds_return_id_idx;
    ALTER TABLE order_refunds DROP COLUMN IF EXISTS return_id;
    ALTER TABLE return_line_items DROP CONSTRAINT IF EXISTS return_line_items_one_line;
    DROP INDEX IF EXISTS return_line_items_order_line_item_id_idx;
    ALTER TABLE return_line_items DROP COLUMN IF EXISTS order_line_item_id;
    ALTER TABLE return_line_items ALTER COLUMN transaction_line_item_id SET NOT NULL;
    ALTER TABLE returns DROP CONSTRAINT IF EXISTS returns_one_sale;
    DROP INDEX IF EXISTS returns_order_id_idx;
    ALTER TABLE returns DROP COLUMN IF EXISTS order_id;
    ALTER TABLE returns ALTER COLUMN transaction_id SET NOT NULL;
  `);
};
