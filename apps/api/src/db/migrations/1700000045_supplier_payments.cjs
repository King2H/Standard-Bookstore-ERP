'use strict';

// Module 1 — Procurement payment lifecycle (stabilization sprint)
//
// Root cause: purchase_orders.financial_status ('unpaid'|'partial'|'paid')
// has existed since migration 19 and is read on every PO row returned to the
// frontend (which already renders it as a distinct "Payment Status" badge),
// but nothing in the backend ever writes to it -- there is no supplier
// payment record of any kind anywhere in the schema. The column is a dead
// default that can never leave 'unpaid', and there is no way to record that
// a supplier was actually paid for a PO. This migration adds the missing
// payment ledger and the PO-level cash/credit distinction needed to drive
// financial_status correctly:
//   - purchase_orders.payment_terms ('cash'|'credit', default 'credit'):
//     lets receivePO() know whether goods received should auto-settle
//     (cash / COD-style procurement) or remain payable until an explicit
//     supplier payment is recorded (credit procurement, the safe default).
//   - supplier_payments: one row per payment against a PO (manual or
//     auto-created on receipt for cash terms), the actual source of truth
//     financial_status is now recomputed from.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE purchase_orders
      ADD COLUMN IF NOT EXISTS payment_terms TEXT NOT NULL DEFAULT 'credit'
        CHECK (payment_terms IN ('cash', 'credit'));
  `);

  pgm.sql(`
    CREATE TABLE supplier_payments (
      id             BIGSERIAL PRIMARY KEY,
      po_id          BIGINT NOT NULL REFERENCES purchase_orders(id),
      branch_id      INTEGER NOT NULL REFERENCES branches(id),
      supplier_id    INTEGER NOT NULL REFERENCES suppliers(id),
      amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      payment_method TEXT NOT NULL DEFAULT 'cash',
      source         TEXT NOT NULL DEFAULT 'manual'
                       CHECK (source IN ('manual', 'auto_on_receipt')),
      notes          TEXT,
      created_by     INTEGER NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX ON supplier_payments (po_id);
    CREATE INDEX ON supplier_payments (branch_id, created_at);
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS supplier_payments CASCADE;
    ALTER TABLE purchase_orders DROP COLUMN IF EXISTS payment_terms;
  `);
};
