'use strict';

// Stock documents (#238, owner decisions 3a, 4a, 2026-11-04).
//
// Purchase orders and goods receipts were numbered by their row id (PO-000003,
// GRN-1), unlike every other document: a fresh shop's first order was
// PO-000003, and numbers skipped. They now carry their own number, counted in
// a daily series (PO-YYYYMMDD-NNNN, GRN-YYYYMMDD-NNNN); the ones already made
// keep the number printed on them (4a).
//
// Goods received on a purchase order were recorded in the stock history with
// reason 'initial', like opening stock. They are 'purchase' (3a), the rows
// already made too: they are identified exactly by what they refer to.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE purchase_orders ADD COLUMN po_number text;
    UPDATE purchase_orders SET po_number = 'PO-' || LPAD(id::text, 6, '0');
    ALTER TABLE purchase_orders ALTER COLUMN po_number SET NOT NULL;
    CREATE UNIQUE INDEX purchase_orders_tenant_po_number ON purchase_orders (tenant_id, po_number);

    ALTER TABLE po_receipts ADD COLUMN receipt_number text;
    UPDATE po_receipts SET receipt_number = 'GRN-' || id;
    ALTER TABLE po_receipts ALTER COLUMN receipt_number SET NOT NULL;
    CREATE UNIQUE INDEX po_receipts_tenant_receipt_number ON po_receipts (tenant_id, receipt_number);

    UPDATE inventory_history SET reason_code = 'purchase'
    WHERE movement_type = 'stock_in' AND reference_type = 'purchase_order' AND reason_code = 'initial';
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    UPDATE inventory_history SET reason_code = 'initial'
    WHERE movement_type = 'stock_in' AND reference_type = 'purchase_order' AND reason_code = 'purchase';
    DROP INDEX po_receipts_tenant_receipt_number;
    ALTER TABLE po_receipts DROP COLUMN receipt_number;
    DROP INDEX purchase_orders_tenant_po_number;
    ALTER TABLE purchase_orders DROP COLUMN po_number;
  `);
};
