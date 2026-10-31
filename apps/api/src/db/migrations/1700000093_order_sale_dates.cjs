'use strict';

// Order events dated when they happen (#175, owner decision a, 2026-10-31).
//
// A sale counts on the day the order is confirmed, a cancellation on its own
// day as a minus, and revenue on the day the order is delivered (fulfilled_at),
// so a day already reported never changes. The reports read
// order_sale_events: one row per confirmation (+1) and per cancellation of a
// confirmed order (-1). Existing orders take their dates from the audit log,
// else from when they were made or last changed.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE orders ADD COLUMN confirmed_at timestamptz, ADD COLUMN cancelled_at timestamptz;

    UPDATE orders o SET confirmed_at = COALESCE(
      (SELECT min(a.created_at) FROM audit_logs a WHERE a.entity_type = 'order' AND a.entity_id = o.id::text AND a.meta->>'action' = 'confirm'),
      o.created_at)
    WHERE o.status NOT IN ('DRAFT', 'Pending')
      AND (o.status NOT IN ('CANCELLED', 'Cancelled')
           -- A cancelled order counts as a sale only if it was confirmed: stock left, or money was taken.
           OR EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity_type = 'order' AND a.entity_id = o.id::text AND a.meta->>'action' = 'confirm')
           OR EXISTS (SELECT 1 FROM inventory_history h WHERE h.reference_type = 'order_confirmed' AND h.reference_id = o.id)
           OR EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id = o.id));

    UPDATE orders o SET cancelled_at = COALESCE(
      (SELECT max(a.created_at) FROM audit_logs a WHERE a.entity_type = 'order' AND a.entity_id = o.id::text AND a.meta->>'action' = 'cancel'),
      o.updated_at, o.created_at)
    WHERE o.status IN ('CANCELLED', 'Cancelled');

    ALTER TABLE orders ADD CONSTRAINT orders_cancelled_at CHECK ((status IN ('CANCELLED', 'Cancelled')) = (cancelled_at IS NOT NULL));

    -- The dates are stamped as the status moves, whoever moves it, like a creation date.
    CREATE FUNCTION orders_stamp_sale_dates() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status NOT IN ('DRAFT', 'Pending', 'CANCELLED', 'Cancelled') AND NEW.confirmed_at IS NULL THEN
        NEW.confirmed_at := now();
      END IF;
      IF NEW.status IN ('CANCELLED', 'Cancelled') AND NEW.cancelled_at IS NULL THEN
        NEW.cancelled_at := now();
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER orders_stamp_sale_dates BEFORE INSERT OR UPDATE OF status ON orders
      FOR EACH ROW EXECUTE FUNCTION orders_stamp_sale_dates();

    -- A sale on its confirmation day, undone on its cancellation day.
    CREATE VIEW order_sale_events WITH (security_invoker = true) AS
      SELECT o.tenant_id, o.id AS order_id, 1 AS sign, o.confirmed_at AS sale_at FROM orders o WHERE o.confirmed_at IS NOT NULL
      UNION ALL
      SELECT o.tenant_id, o.id, -1, o.cancelled_at FROM orders o WHERE o.confirmed_at IS NOT NULL AND o.cancelled_at IS NOT NULL;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DROP VIEW IF EXISTS order_sale_events;
    DROP TRIGGER IF EXISTS orders_stamp_sale_dates ON orders;
    DROP FUNCTION IF EXISTS orders_stamp_sale_dates();
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_cancelled_at;
    ALTER TABLE orders DROP COLUMN cancelled_at, DROP COLUMN confirmed_at;
  `);
};
