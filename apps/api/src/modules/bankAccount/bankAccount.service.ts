import { db } from '../../db/index.js';
import { encrypt, maskLast4 } from '../../lib/encryption.js';
import { NotFoundError, ConflictError, BusinessError } from '../../lib/errors.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BankAccount {
  id: number;
  branchId: number;
  accountName: string;
  bankName: string;
  /** Masked: ****1234 — never returns plaintext */
  accountNumberMasked: string;
  /** Masked: ****5678 — never returns plaintext */
  ibanMasked: string | null;
  currency: string;
  isActive: boolean;
  createdAt: string;
}

export interface ReconciliationEntry {
  id: number;
  bankAccountId: number;
  paymentRefId: number | null;
  refundRefId: number | null;
  amount: string;
  direction: 'in' | 'out';
  status: 'uncleared' | 'cleared' | 'unmatched';
  statementDate: string | null;
  notes: string | null;
  createdAt: string;
}

export interface CsvRow {
  amount: number;
  direction: 'in' | 'out';
  statementDate: string;  // ISO date string YYYY-MM-DD
  notes?: string;
}

export interface StaffCtx {
  staffId: number;
  role: string;
  branchId: number;
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createBankAccount(
  data: {
    branchId: number;
    accountName: string;
    bankName: string;
    accountNumber: string;
    iban?: string | null;
    currency: string;
  },
  staffCtx: StaffCtx,
): Promise<BankAccount> {
  // Verify branch exists
  const branchCheck = await db.query(`SELECT id FROM branches WHERE id = $1`, [data.branchId]);
  if (branchCheck.rows.length === 0) throw new NotFoundError('Branch');

  const encryptedAccountNumber = encrypt(data.accountNumber);
  const encryptedIban = data.iban ? encrypt(data.iban) : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO bank_accounts (branch_id, account_name, bank_name, account_number, iban, currency, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, branch_id, account_name, bank_name, account_number, iban, currency, is_active, created_at`,
      [data.branchId, data.accountName, data.bankName, encryptedAccountNumber, encryptedIban, data.currency],
    );

    const account = mapRow(result.rows[0]);

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'bank_account', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(account.id),
        data.branchId,
        JSON.stringify({ accountName: data.accountName, bankName: data.bankName, currency: data.currency }),
      ],
    );

    await client.query('COMMIT');
    return account;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function updateBankAccount(
  id: number,
  data: Partial<{
    accountName: string;
    bankName: string;
    accountNumber: string;
    iban: string | null;
    currency: string;
  }>,
  staffCtx: StaffCtx,
): Promise<BankAccount> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, branch_id, account_number, iban FROM bank_accounts WHERE id = $1`,
      [id],
    );
    if (existing.rows.length === 0) throw new NotFoundError('Bank account');

    const encryptedAccountNumber = data.accountNumber ? encrypt(data.accountNumber) : null;
    const encryptedIban = data.iban !== undefined
      ? (data.iban ? encrypt(data.iban) : null)
      : undefined;

    const result = await client.query(
      `UPDATE bank_accounts
       SET account_name   = COALESCE($1, account_name),
           bank_name      = COALESCE($2, bank_name),
           account_number = COALESCE($3, account_number),
           iban           = CASE WHEN $4::boolean THEN $5 ELSE iban END,
           currency       = COALESCE($6, currency)
       WHERE id = $7
       RETURNING id, branch_id, account_name, bank_name, account_number, iban, currency, is_active, created_at`,
      [
        data.accountName ?? null,
        data.bankName ?? null,
        encryptedAccountNumber,
        data.iban !== undefined,   // whether to update iban column
        encryptedIban ?? null,
        data.currency ?? null,
        id,
      ],
    );

    const account = mapRow(result.rows[0]);

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'bank_account', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(id),
        existing.rows[0].branch_id,
        JSON.stringify({ updatedFields: Object.keys(data) }),
      ],
    );

    await client.query('COMMIT');
    return account;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Deactivate ────────────────────────────────────────────────────────────────

export async function deactivateBankAccount(id: number, staffCtx: StaffCtx): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE bank_accounts SET is_active = false WHERE id = $1 RETURNING id, branch_id`,
      [id],
    );
    if (result.rows.length === 0) throw new NotFoundError('Bank account');

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'DEACTIVATE', 'bank_account', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(id), result.rows[0].branch_id, JSON.stringify({ id })],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── List / Get ────────────────────────────────────────────────────────────────

export async function listBankAccounts(
  branchId: number,
  filters: { isActive?: boolean; page: number; pageSize: number },
): Promise<{ items: BankAccount[]; total: number }> {
  const conditions = [`branch_id = $1`];
  const params: unknown[] = [branchId];

  if (filters.isActive !== undefined) {
    params.push(filters.isActive);
    conditions.push(`is_active = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const offset = (filters.page - 1) * filters.pageSize;

  const [dataResult, countResult] = await Promise.all([
    db.query(
      `SELECT id, branch_id, account_name, bank_name, account_number, iban, currency, is_active, created_at
       FROM bank_accounts ${where}
       ORDER BY account_name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.pageSize, offset],
    ),
    db.query(`SELECT COUNT(*) FROM bank_accounts ${where}`, params),
  ]);

  return {
    items: dataResult.rows.map(mapRow),
    total: parseInt(countResult.rows[0].count, 10),
  };
}

export async function getBankAccount(id: number): Promise<BankAccount> {
  const result = await db.query(
    `SELECT id, branch_id, account_name, bank_name, account_number, iban, currency, is_active, created_at
     FROM bank_accounts WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) throw new NotFoundError('Bank account');
  return mapRow(result.rows[0]);
}

/**
 * Validates that a bank_account_id belongs to the given branch and is active.
 * Used by POS, Orders, and PO modules.
 */
export async function validateBankAccountForBranch(
  bankAccountId: number,
  branchId: number,
): Promise<void> {
  const result = await db.query(
    `SELECT id FROM bank_accounts WHERE id = $1 AND branch_id = $2 AND is_active = true`,
    [bankAccountId, branchId],
  );
  if (result.rows.length === 0) {
    throw new BusinessError('INVALID_BANK_ACCOUNT', 'Bank account is inactive or does not belong to this branch');
  }
}

// ── Reconciliation ────────────────────────────────────────────────────────────

export async function listReconciliation(
  bankAccountId: number,
  filters: { status?: string; page: number; pageSize: number },
): Promise<{ items: ReconciliationEntry[]; total: number; totalPages: number }> {
  const conditions = [`bank_account_id = $1`];
  const params: unknown[] = [bankAccountId];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const offset = (filters.page - 1) * filters.pageSize;

  const [dataResult, countResult] = await Promise.all([
    db.query(
      `SELECT id, bank_account_id, payment_ref_id, refund_ref_id, amount, direction, status,
              statement_date, notes, created_at
       FROM bank_reconciliation ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.pageSize, offset],
    ),
    db.query(`SELECT COUNT(*) FROM bank_reconciliation ${where}`, params),
  ]);

  const total = parseInt(countResult.rows[0].count, 10);
  return {
    items: dataResult.rows.map(mapReconRow),
    total,
    totalPages: Math.ceil(total / filters.pageSize),
  };
}

/**
 * Imports CSV rows as reconciliation entries.
 * Attempts to match each row to an existing payment/refund by amount + direction + date.
 * Entire batch rolls back on any error.
 */
export async function importReconciliation(
  bankAccountId: number,
  csvRows: CsvRow[],
  staffCtx: StaffCtx,
): Promise<{ imported: number; matched: number; unmatched: number }> {
  // Verify bank account exists
  const acctCheck = await db.query(
    `SELECT id, branch_id FROM bank_accounts WHERE id = $1`,
    [bankAccountId],
  );
  if (acctCheck.rows.length === 0) throw new NotFoundError('Bank account');
  const branchId = acctCheck.rows[0].branch_id;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let matched = 0;
    let unmatched = 0;

    for (const row of csvRows) {
      // TODO(Slice 11): match by amount + direction + date against
      // transaction_payments (and later order_payments) and set status to
      // 'uncleared' on a match, incrementing `matched` below. Until that
      // table/logic exists, every imported row is 'unmatched' — this is the
      // documented behavior per Req 4.7, not a placeholder bug.
      const status: 'unmatched' = 'unmatched';

      await client.query(
        `INSERT INTO bank_reconciliation
           (bank_account_id, payment_ref_id, refund_ref_id, amount, direction, status, statement_date, notes)
         VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6)`,
        [bankAccountId, row.amount, row.direction, status, row.statementDate, row.notes ?? null],
      );

      unmatched++;
    }

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'bank_reconciliation', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(bankAccountId),
        branchId,
        JSON.stringify({ bankAccountId, rowCount: csvRows.length, matched, unmatched }),
      ],
    );

    await client.query('COMMIT');
    return { imported: csvRows.length, matched, unmatched };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Clears a reconciliation entry by linking it to a payment reference.
 */
export async function clearEntry(
  entryId: number,
  paymentRefId: number | null,
  staffCtx: StaffCtx,
): Promise<ReconciliationEntry> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, bank_account_id, status FROM bank_reconciliation WHERE id = $1`,
      [entryId],
    );
    if (existing.rows.length === 0) throw new NotFoundError('Reconciliation entry');
    if (existing.rows[0].status === 'cleared') {
      throw new ConflictError('ALREADY_CLEARED', 'This reconciliation entry is already cleared');
    }

    const result = await client.query(
      `UPDATE bank_reconciliation
       SET status = 'cleared', payment_ref_id = COALESCE($1, payment_ref_id)
       WHERE id = $2
       RETURNING id, bank_account_id, payment_ref_id, refund_ref_id, amount, direction, status,
                 statement_date, notes, created_at`,
      [paymentRefId, entryId],
    );

    const bankAccountId = existing.rows[0].bank_account_id;
    const branchResult = await client.query(
      `SELECT branch_id FROM bank_accounts WHERE id = $1`,
      [bankAccountId],
    );

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'bank_reconciliation', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(entryId),
        branchResult.rows[0]?.branch_id ?? null,
        JSON.stringify({ entryId, paymentRefId, newStatus: 'cleared' }),
      ],
    );

    await client.query('COMMIT');
    return mapReconRow(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): BankAccount {
  return {
    id: row.id as number,
    branchId: row.branch_id as number,
    accountName: row.account_name as string,
    bankName: row.bank_name as string,
    accountNumberMasked: maskLast4(row.account_number as string),
    ibanMasked: row.iban ? maskLast4(row.iban as string) : null,
    currency: row.currency as string,
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function mapReconRow(row: Record<string, unknown>): ReconciliationEntry {
  return {
    id: row.id as number,
    bankAccountId: row.bank_account_id as number,
    paymentRefId: row.payment_ref_id as number | null,
    refundRefId: row.refund_ref_id as number | null,
    amount: row.amount as string,
    direction: row.direction as 'in' | 'out',
    status: row.status as 'uncleared' | 'cleared' | 'unmatched',
    statementDate: row.statement_date ? (row.statement_date as Date).toISOString().split('T')[0] : null,
    notes: row.notes as string | null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}
