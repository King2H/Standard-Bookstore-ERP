'use strict';

// Bank accounts and reconciliation (#21, step 4). Owner decisions 1a, 2a, 3a.
//
// 1. Two-sided reconciliation (1a). bank_reconciliation holds the system's own
// bank movements (payments in, refunds and supplier payments out), each named
// by its source. Statement lines imported from the bank move to their own
// table, bank_statement_lines; v1 kept them in bank_reconciliation as
// "unmatched" rows, where they could never meet the movement they stood for.
// A line is matched to one movement, and both are then cleared.
//
// 2. Every bank payment can name the account it went to (2a): POS payments,
// return refunds, exchange settlements and supplier payments get the column
// order payments and refunds already have.
//
// 3. Accounts are in ETB (3a, like purchase orders; foreign currency: #106),
// and an account number is registered once in the company: its lookup hash is
// unique. Hashing an existing number needs COLUMN_ENCRYPTION_KEY, the key the
// API uses (npm run migrate reads it from .env); the format matches
// src/lib/encryption.ts, and the hash src/modules/bankAccount (sha256 of the
// number without spaces or dashes, upper-cased).

const crypto = require('crypto');

exports.shorthands = undefined;

function key() {
  const hex = process.env.COLUMN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'COLUMN_ENCRYPTION_KEY must be set (the same key the API uses) to index existing bank account numbers. ' +
        'Add it to .env and run the migration again.',
    );
  }
  return Buffer.from(hex, 'hex');
}

function decrypt(ciphertext) {
  const buf = Buffer.from(ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

function numberHash(accountNumber) {
  return crypto.createHash('sha256').update(accountNumber.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
}

exports.up = async function (pgm) {
  const q = (text, params) => pgm.db.query(text, params);

  // ── Accounts ────────────────────────────────────────────────────────────────
  await q(`ALTER TABLE bank_accounts ADD COLUMN account_number_hash TEXT`);
  const { rows: accounts } = await q(`SELECT id, account_number FROM bank_accounts`);
  for (const a of accounts) {
    await q(`UPDATE bank_accounts SET account_number_hash = $2 WHERE id = $1`, [a.id, numberHash(decrypt(a.account_number))]);
  }
  const { rows: clashes } = await q(
    `SELECT string_agg(id::text, ', ' ORDER BY id) AS ids FROM bank_accounts GROUP BY account_number_hash HAVING count(*) > 1`,
  );
  if (clashes.length > 0) {
    throw new Error(
      `Bank accounts registered twice with the same number (ids ${clashes.map((c) => c.ids).join('; ')}). ` +
        'Deactivate and renumber one of each, then migrate again.',
    );
  }
  await q(`ALTER TABLE bank_accounts ALTER COLUMN account_number_hash SET NOT NULL`);
  await q(`CREATE UNIQUE INDEX bank_accounts_account_number_hash_key ON bank_accounts (account_number_hash)`);
  // Existing accounts in another currency stay readable; new ones are ETB.
  await q(`ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_currency_etb CHECK (currency = 'ETB') NOT VALID`);

  // ── The system's bank movements ─────────────────────────────────────────────
  await q(`
    ALTER TABLE bank_reconciliation
      ADD COLUMN source_type TEXT
        CONSTRAINT bank_reconciliation_source_type_check CHECK (source_type IN (
          'order_payment', 'order_refund', 'receivable_payment', 'pos_payment', 'pos_void',
          'return_refund', 'exchange_payment', 'exchange_void', 'supplier_payment')),
      ADD COLUMN source_id TEXT
  `);
  await q(`UPDATE bank_reconciliation SET source_type = 'order_refund', source_id = refund_ref_id::text WHERE refund_ref_id IS NOT NULL`);
  await q(`
    UPDATE bank_reconciliation SET source_type = 'receivable_payment', source_id = payment_ref_id::text
    WHERE source_type IS NULL AND statement_date IS NULL AND notes LIKE 'Receivable #%'
  `);
  await q(`
    UPDATE bank_reconciliation SET source_type = 'order_payment', source_id = payment_ref_id::text
    WHERE source_type IS NULL AND statement_date IS NULL AND payment_ref_id IS NOT NULL
  `);

  // ── Statement lines ─────────────────────────────────────────────────────────
  await q(`
    CREATE TABLE bank_statement_lines (
      id              BIGSERIAL PRIMARY KEY,
      bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
      statement_date  DATE NOT NULL,
      amount          NUMERIC(14,2) NOT NULL CONSTRAINT bank_statement_lines_amount_check CHECK (amount > 0),
      direction       TEXT NOT NULL CONSTRAINT bank_statement_lines_direction_check CHECK (direction IN ('in', 'out')),
      -- The bank's own reference for the line; a line with one is imported once.
      reference       TEXT,
      description     TEXT,
      -- The movement it was matched to; one line per movement.
      entry_id        BIGINT UNIQUE REFERENCES bank_reconciliation(id),
      matched_by      INTEGER REFERENCES staff(id),
      matched_at      TIMESTAMPTZ,
      imported_by     INTEGER REFERENCES staff(id),
      imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT bank_statement_lines_match_recorded CHECK ((entry_id IS NULL) = (matched_at IS NULL))
    );
    CREATE UNIQUE INDEX bank_statement_lines_reference_key ON bank_statement_lines (bank_account_id, reference) WHERE reference IS NOT NULL;
    CREATE INDEX bank_statement_lines_account_idx ON bank_statement_lines (bank_account_id, statement_date);
  `);
  // v1's imported rows (and any row without a source) become open statement lines.
  await q(`
    INSERT INTO bank_statement_lines (bank_account_id, statement_date, amount, direction, description, imported_at)
    SELECT bank_account_id, COALESCE(statement_date, created_at::date), amount, direction, notes, created_at
    FROM bank_reconciliation WHERE source_type IS NULL
  `);
  await q(`DELETE FROM bank_reconciliation WHERE source_type IS NULL`);
  await q(`ALTER TABLE bank_reconciliation ALTER COLUMN source_type SET NOT NULL, ALTER COLUMN source_id SET NOT NULL`);
  await q(`
    ALTER TABLE bank_reconciliation
      DROP CONSTRAINT bank_reconciliation_status_check,
      ADD CONSTRAINT bank_reconciliation_status_check CHECK (status IN ('uncleared', 'cleared'))
  `);
  await q(`CREATE UNIQUE INDEX bank_reconciliation_source_key ON bank_reconciliation (source_type, source_id)`);

  // ── The account each bank payment went to ───────────────────────────────────
  for (const table of ['transaction_payments', 'refunds', 'exchange_settlement_entries', 'supplier_payments']) {
    await q(`ALTER TABLE ${table} ADD COLUMN bank_account_id INTEGER REFERENCES bank_accounts(id)`);
  }
};

exports.down = async function (pgm) {
  const q = (text) => pgm.db.query(text);
  for (const table of ['transaction_payments', 'refunds', 'exchange_settlement_entries', 'supplier_payments']) {
    await q(`ALTER TABLE ${table} DROP COLUMN bank_account_id`);
  }
  await q(`DROP INDEX bank_reconciliation_source_key`);
  await q(`
    ALTER TABLE bank_reconciliation
      DROP CONSTRAINT bank_reconciliation_status_check,
      ADD CONSTRAINT bank_reconciliation_status_check CHECK (status IN ('uncleared', 'cleared', 'unmatched'))
  `);
  await q(`
    INSERT INTO bank_reconciliation (bank_account_id, amount, direction, status, statement_date, notes, created_at, source_type, source_id)
    SELECT bank_account_id, amount, direction, 'unmatched', statement_date, description, imported_at, 'order_payment', 'line-' || id
    FROM bank_statement_lines
  `);
  await q(`DROP TABLE bank_statement_lines`);
  await q(`ALTER TABLE bank_reconciliation DROP COLUMN source_type, DROP COLUMN source_id`);
  await q(`ALTER TABLE bank_accounts DROP CONSTRAINT bank_accounts_currency_etb`);
  await q(`DROP INDEX bank_accounts_account_number_hash_key`);
  await q(`ALTER TABLE bank_accounts DROP COLUMN account_number_hash`);
};
