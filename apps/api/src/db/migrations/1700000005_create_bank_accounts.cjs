'use strict';

exports.shorthands = undefined;

exports.up = function (pgm) {
  // ── bank_accounts ──────────────────────────────────────────────────────────
  pgm.createTable('bank_accounts', {
    id:             { type: 'serial', primaryKey: true },
    branch_id:      { type: 'integer', notNull: true, references: 'branches(id)', onDelete: 'RESTRICT' },
    account_name:   { type: 'text', notNull: true },
    bank_name:      { type: 'text', notNull: true },
    account_number: { type: 'text', notNull: true },   // AES-256-GCM encrypted at app layer
    iban:           { type: 'text' },                  // AES-256-GCM encrypted, nullable
    currency:       { type: 'text', notNull: true },
    is_active:      { type: 'boolean', notNull: true, default: true },
    created_at:     { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addIndex('bank_accounts', ['branch_id', 'is_active']);

  // ── bank_reconciliation ────────────────────────────────────────────────────
  pgm.createTable('bank_reconciliation', {
    id:              { type: 'bigserial', primaryKey: true },
    bank_account_id: { type: 'integer', notNull: true, references: 'bank_accounts(id)', onDelete: 'RESTRICT' },
    payment_ref_id:  { type: 'bigint' },   // nullable — links to transaction_payments or order_payments
    refund_ref_id:   { type: 'bigint' },   // nullable — links to refunds or order_refunds
    amount:          { type: 'numeric(14,2)', notNull: true },
    direction:       { type: 'text', notNull: true },
    status:          { type: 'text', notNull: true, default: 'uncleared' },
    statement_date:  { type: 'date' },
    notes:           { type: 'text' },
    created_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('bank_reconciliation', 'bank_reconciliation_direction_check',
    `CHECK (direction IN ('in','out'))`);
  pgm.addConstraint('bank_reconciliation', 'bank_reconciliation_status_check',
    `CHECK (status IN ('uncleared','cleared','unmatched'))`);
  pgm.addIndex('bank_reconciliation', ['bank_account_id', 'status']);
};

exports.down = function (pgm) {
  pgm.dropTable('bank_reconciliation');
  pgm.dropTable('bank_accounts');
};
