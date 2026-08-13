'use strict';

// Prompt 2 — Modern KPI Dashboard, Synchronized Reports & Production-Grade
// Procurement Lifecycle.
//
// Adds the one genuinely missing piece needed for a real supplier ledger:
// a credit note record (a supplier-issued credit against a PO — e.g. for
// damaged goods, an overcharge, or the "use a credit note instead of
// editing PO prices after receipt" rule that was previously only a
// documented convention with no supported mechanism). Entirely additive —
// no existing column is touched.
//
// The supplier ledger itself (PO / Goods Receipt / Payment / Credit Note /
// running Balance) is computed at query time from this table plus the
// existing po_line_items/po_receipts/supplier_payments — deliberately NOT
// a second stored ledger table, to avoid a second source of truth that
// could drift out of sync with the underlying records.

exports.shorthands = undefined;

exports.up = async function (pgm) {
  pgm.createTable('supplier_credit_notes', {
    id: 'id',
    po_id: { type: 'bigint', notNull: true, references: 'purchase_orders', onDelete: 'CASCADE' },
    supplier_id: { type: 'integer', notNull: true, references: 'suppliers' },
    branch_id: { type: 'integer', notNull: true, references: 'branches' },
    amount: { type: 'numeric(14,2)', notNull: true },
    reason: { type: 'text', notNull: true },
    created_by: { type: 'integer', notNull: true, references: 'staff' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('supplier_credit_notes', 'supplier_credit_notes_amount_check', 'CHECK (amount > 0)');
  pgm.createIndex('supplier_credit_notes', 'po_id');
  pgm.createIndex('supplier_credit_notes', ['branch_id', 'created_at']);
};

exports.down = function (pgm) {
  pgm.dropTable('supplier_credit_notes');
};
