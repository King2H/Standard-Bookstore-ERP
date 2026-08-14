/**
 * Receivables Service
 *
 * Single source of truth for all customer debt tracking.
 * Covers: Credit POS Sales and Exchange Difference (Customer_Pays) settlements.
 *
 * Design principles:
 * - All writes to `receivables` go through this module
 * - Hooks are called WITHIN the parent transaction (same PoolClient) for atomicity
 * - Hook failures are silent: a missing receivable never breaks POS or Exchange flows
 */

import type { PoolClient } from 'pg';
import { db } from '../../db/index.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReceivableStatus = 'Pending' | 'PartiallyPaid' | 'Settled' | 'Overdue';
export type ReceivableSourceType = 'pos_credit_sale' | 'exchange_difference' | 'order_credit_sale';

export interface StaffCtx { staffId: number; role: string; branchId: number; }

export interface ReceivableRow {
  id: string;
  sourceType: ReceivableSourceType;
  sourceRefId: string;
  sourceEntityId: string;
  customerId: number;
  customerName: string | null;
  customerCode: string | null;
  branchId: number;
  originalAmount: number;
  outstandingAmount: number;
  currency: string;
  dueDate: string | null;
  settlementDate: string | null;
  status: ReceivableStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Row mapper ────────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): ReceivableRow {
  return {
    id: String(row.id),
    sourceType: row.source_type as ReceivableSourceType,
    sourceRefId: row.source_ref_id as string,
    sourceEntityId: String(row.source_entity_id),
    customerId: row.customer_id as number,
    customerName: (row.customer_name as string | null) ?? null,
    customerCode: (row.customer_code as string | null) ?? null,
    branchId: row.branch_id as number,
    originalAmount: parseFloat(row.original_amount as string),
    outstandingAmount: parseFloat(row.outstanding_amount as string),
    currency: row.currency as string,
    dueDate: row.due_date
      ? (row.due_date instanceof Date
          ? new Date(row.due_date.getTime() - row.due_date.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
          : String(row.due_date))
      : null,
    settlementDate: row.settlement_date
      ? (row.settlement_date as Date).toISOString()
      : null,
    status: row.status as ReceivableStatus,
    notes: (row.notes as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

// ── createReceivable (called within parent DB transaction) ────────────────────

export async function createReceivable(
  data: {
    sourceType: ReceivableSourceType;
    sourceRefId: string;
    sourceEntityId: number;
    customerId: number;
    branchId: number;
    originalAmount: number;
    dueDate?: string | null;
    notes?: string;
  },
  client: PoolClient,
): Promise<void> {
  if (data.originalAmount <= 0) return; // Nothing to track

  await client.query(
    `INSERT INTO receivables
       (source_type, source_ref_id, source_entity_id, customer_id, branch_id,
        original_amount, outstanding_amount, currency, due_date, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'ETB', $7, 'Pending', $8)
     ON CONFLICT (source_type, source_entity_id) DO NOTHING`,
    [
      data.sourceType,
      data.sourceRefId,
      data.sourceEntityId,
      data.customerId,
      data.branchId,
      data.originalAmount.toFixed(2),
      data.dueDate ?? null,
      data.notes ?? null,
    ],
  );
}

// ── updateReceivableOnPayment (hook called within payment DB transaction) ─────

export async function updateReceivableOnPayment(
  opts: {
    sourceType: ReceivableSourceType;
    sourceEntityId: number;
    /** Remaining amount owed AFTER this payment. Must be >= 0. */
    newOutstandingAmount: number;
    isFullySettled: boolean;
  },
  client: PoolClient,
): Promise<void> {
  // Clamp to zero to guard against floating-point over-payment (within the 0.01 tolerance
  // already enforced by the caller). Both the isFullySettled=true path and the
  // outstanding=0 path in the else branch lead to 'Settled'.
  const outstanding = Math.max(0, parseFloat(opts.newOutstandingAmount.toFixed(2)));
  const fullySettled = opts.isFullySettled || outstanding === 0;

  // Bug 4: Guard against updating receivables linked to cancelled orders.
  // If the linked order is CANCELLED, the financial lifecycle is frozen.
  if (opts.sourceType === 'order_credit_sale') {
    const orderCheck = await client.query(
      `SELECT status FROM orders WHERE id = $1 LIMIT 1`,
      [opts.sourceEntityId],
    );
    if (orderCheck.rows.length) {
      const orderStatus = String(orderCheck.rows[0].status ?? '').toUpperCase();
      if (orderStatus === 'CANCELLED') {
        // Silently skip — cancelled orders have frozen financial lifecycle.
        // The caller (createPayment) already rejects cash/cancelled orders
        // at the entry point; this is a defensive secondary guard.
        return;
      }
    }
  }

  if (fullySettled) {
    await client.query(
      `UPDATE receivables
       SET status            = 'Settled',
           outstanding_amount = 0,
           settlement_date   = now(),
           updated_at        = now()
       WHERE source_type      = $1
         AND source_entity_id = $2
         AND status          != 'Settled'`,
      [opts.sourceType, opts.sourceEntityId],
    );
  } else {
    // outstanding > 0: determine status from the current receivable status.
    // Pending  → PartiallyPaid (first partial payment)
    // Overdue  → PartiallyPaid (partial payment received, still owed)
    // PartiallyPaid → PartiallyPaid (subsequent partial payment)
    await client.query(
      `UPDATE receivables
       SET status = CASE
             WHEN status IN ('Pending', 'Overdue') THEN 'PartiallyPaid'
             ELSE status   -- already 'PartiallyPaid', keep it
           END,
           outstanding_amount = $3,
           updated_at        = now()
       WHERE source_type      = $1
         AND source_entity_id = $2
         AND status NOT IN ('Settled')`,
      [opts.sourceType, opts.sourceEntityId, outstanding.toFixed(2)],
    );
  }
}

// ── markOverdueReceivables (scheduled job) ────────────────────────────────────

export async function markOverdueReceivables(): Promise<number> {
  const result = await db.query(
    `UPDATE receivables
     SET status = 'Overdue', updated_at = now()
     WHERE status IN ('Pending', 'PartiallyPaid')
       AND due_date IS NOT NULL
       AND due_date < CURRENT_DATE
     RETURNING id`,
  );
  return result.rowCount ?? 0;
}

// ── getById ───────────────────────────────────────────────────────────────────

export async function getById(id: string | number): Promise<ReceivableRow> {
  const result = await db.query(
    `SELECT r.*,
            c.full_name  AS customer_name,
            c.customer_code
     FROM receivables r
     LEFT JOIN customers c ON c.id = r.customer_id
     WHERE r.id = $1`,
    [id],
  );
  if (!result.rows.length) throw new NotFoundError('Receivable');
  return mapRow(result.rows[0]);
}

// ── list ──────────────────────────────────────────────────────────────────────

export async function list(opts: {
  branchId?: number;
  customerId?: number;
  status?: string;
  sourceType?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  overdueOnly?: boolean;
  page?: number;
  pageSize?: number;
}): Promise<{ items: ReceivableRow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.branchId)    { params.push(opts.branchId);    conditions.push(`r.branch_id = $${params.length}`); }
  if (opts.customerId)  { params.push(opts.customerId);  conditions.push(`r.customer_id = $${params.length}`); }
  // Module 6: accept a comma-separated status list (dashboard drill-downs pass
  // multiple statuses, e.g. "Pending,PartiallyPaid,Overdue") alongside the
  // single-value case.
  if (opts.status) {
    const statuses = opts.status.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length > 1) {
      params.push(statuses); conditions.push(`r.status = ANY($${params.length}::text[])`);
    } else if (statuses.length === 1) {
      params.push(statuses[0]); conditions.push(`r.status = $${params.length}`);
    }
  }
  if (opts.sourceType)  { params.push(opts.sourceType);  conditions.push(`r.source_type = $${params.length}`); }
  if (opts.dueDateFrom) { params.push(opts.dueDateFrom); conditions.push(`r.due_date >= $${params.length}`); }
  if (opts.dueDateTo)   { params.push(opts.dueDateTo);   conditions.push(`r.due_date <= $${params.length}`); }
  if (opts.overdueOnly) {
    conditions.push(`r.status = 'Overdue'`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const li = params.length + 1;
  const oi = params.length + 2;

  const [countRes, dataRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*) FROM receivables r ${where}`,
      params,
    ),
    db.query(
      `SELECT r.*, c.full_name AS customer_name, c.customer_code
       FROM receivables r
       LEFT JOIN customers c ON c.id = r.customer_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT $${li} OFFSET $${oi}`,
      [...params, pageSize, offset],
    ),
  ]);

  return {
    items: dataRes.rows.map(mapRow),
    total: parseInt(countRes.rows[0].count as string, 10),
    page,
    totalPages: Math.ceil(parseInt(countRes.rows[0].count as string, 10) / pageSize),
  };
}

// ── collectPayment (exchange_difference receivables) ──────────────────────────
// Module 3 fix: order_credit_sale receivables are paid down through
// payments.service.ts createPayment() and pos_credit_sale receivables through
// pos.service.ts recordPayment() -- both fully-featured (cash/bank/store_credit,
// bank reconciliation, financial audit trail). exchange_difference receivables
// (opened by Customer_Pays exchanges, see exchanges.service.ts
// applyExchangeSettlementEffects()) had no equivalent -- the only way to close
// one was manualSettle() below, which records no payment at all. This mirrors
// the same cash/bank/store_credit handling for the one source type that was
// missing it, writing to financial_transactions (the same exchange-linked
// ledger the Payments report already reads, per the Module 2 fix) so the
// money is visible everywhere a real payment is, not just marked away.
//
// Routing which of these three functions handles a given receivable is the
// caller's job (receivables.routes.ts POST /:id/collect) -- keeping it there
// avoids a receivables.service.ts <-> payments.service.ts import cycle.

export async function collectPayment(
  id: string | number,
  data: {
    amount: number;
    paymentMethod: 'cash' | 'bank' | 'mobile' | 'store_credit';
    bankAccountId?: number | null;
    notes?: string;
  },
  staffCtx: StaffCtx,
): Promise<ReceivableRow> {
  const receivable = await getById(id);
  if (receivable.status === 'Settled') {
    throw new BusinessError('RECEIVABLE_ALREADY_SETTLED', 'Receivable is already settled');
  }
  if (!(data.amount > 0)) throw new ValidationError('Payment amount must be positive');
  if (data.amount > receivable.outstandingAmount + 0.01) {
    throw new BusinessError(
      'EXCEEDS_OUTSTANDING',
      `Payment of ETB ${data.amount.toFixed(2)} exceeds outstanding balance of ETB ${receivable.outstandingAmount.toFixed(2)}`,
      { outstanding: receivable.outstandingAmount, requested: data.amount },
    );
  }
  if (data.paymentMethod === 'bank' && !data.bankAccountId) {
    throw new ValidationError('bankAccountId is required for bank transfer payments');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (data.paymentMethod === 'store_credit') {
      const scRes = await client.query(
        'SELECT balance FROM store_credit_accounts WHERE customer_id = $1 FOR UPDATE',
        [receivable.customerId],
      );
      const available = scRes.rows.length ? parseFloat(scRes.rows[0].balance as string) : 0;
      if (available < data.amount - 0.01) {
        throw new BusinessError(
          'INSUFFICIENT_STORE_CREDIT',
          `Insufficient store credit. Available: ETB ${available.toFixed(2)}, requested: ETB ${data.amount.toFixed(2)}`,
          { available, requested: data.amount },
        );
      }
      await client.query(
        'UPDATE store_credit_accounts SET balance = balance - $1 WHERE customer_id = $2',
        [data.amount.toFixed(2), receivable.customerId],
      );
      await client.query(
        `INSERT INTO store_credit_history (customer_id, ref_type, ref_id, amount, direction)
         VALUES ($1, 'receivable_payment', $2, $3, 'debit')`,
        [receivable.customerId, String(id), data.amount.toFixed(2)],
      );
    }

    // Real, reportable payment record -- financial_transactions is the same
    // ledger getPaymentReport() aggregates exchange-linked entries from.
    const exchangeId = receivable.sourceType === 'exchange_difference'
      ? parseInt(receivable.sourceEntityId, 10)
      : null;
    const idempotencyKey = `receivable-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ftRes = await client.query(
      `INSERT INTO financial_transactions (type, exchange_id, idempotency_key, amount, currency, method, staff_id, branch_id, meta)
       VALUES ('payment', $1, $2, $3, 'ETB', $4, $5, $6, $7)
       RETURNING id`,
      [
        exchangeId, idempotencyKey, data.amount.toFixed(2), data.paymentMethod,
        staffCtx.staffId, staffCtx.branchId,
        JSON.stringify({ receivableId: String(id), sourceType: receivable.sourceType, notes: data.notes ?? null }),
      ],
    );

    if (data.paymentMethod === 'bank' && data.bankAccountId) {
      await client.query(
        `INSERT INTO bank_reconciliation (bank_account_id, payment_ref_id, amount, direction, status, notes)
         VALUES ($1, $2, $3, 'in', 'uncleared', $4)`,
        [data.bankAccountId, ftRes.rows[0].id, data.amount.toFixed(2), `Receivable #${id} payment`],
      );
    }

    const newOutstanding = Math.max(0, parseFloat((receivable.outstandingAmount - data.amount).toFixed(2)));
    await updateReceivableOnPayment(
      {
        sourceType: receivable.sourceType,
        sourceEntityId: parseInt(receivable.sourceEntityId, 10),
        newOutstandingAmount: newOutstanding,
        isFullySettled: newOutstanding <= 0.01,
      },
      client,
    );

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'receivable_payment', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId,
       JSON.stringify({ amount: data.amount, paymentMethod: data.paymentMethod, notes: data.notes ?? null })],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getById(id);
}

// ── manualSettle (write-off — no payment is collected) ────────────────────────
// Distinct from collectPayment()/createPayment()/recordPayment() above: this
// records NO money movement anywhere. Restricted to Admin/Manager/
// Finance_Officer (receivables.routes.ts) -- it exists for bad-debt write-offs,
// not routine "the customer paid" collection, which must always go through
// one of the three functions above so the amount is auditable and shows up
// in Payments/Dashboard reporting.

export async function manualSettle(
  id: string | number,
  notes: string | undefined,
  staffCtx: StaffCtx,
): Promise<ReceivableRow> {
  const receivable = await getById(id);
  if (receivable.status === 'Settled') {
    throw new BusinessError('RECEIVABLE_ALREADY_SETTLED', 'Receivable is already settled');
  }

  await db.query(
    `UPDATE receivables
     SET status = 'Settled',
         outstanding_amount = 0,
         settlement_date = now(),
         notes = COALESCE($2, notes),
         updated_at = now()
     WHERE id = $1`,
    [id, notes ?? null],
  );

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'receivable', $3, $4, $5)`,
    [
      staffCtx.staffId,
      staffCtx.role,
      String(id),
      staffCtx.branchId,
      JSON.stringify({ action: 'manual_settle', receivableId: id }),
    ],
  );

  return getById(id);
}

// ── updateDueDate ─────────────────────────────────────────────────────────────

export async function updateDueDate(
  id: string | number,
  dueDate: string | null,
  staffCtx: StaffCtx,
): Promise<ReceivableRow> {
  const receivable = await getById(id);
  if (receivable.status === 'Settled') {
    throw new BusinessError('RECEIVABLE_ALREADY_SETTLED', 'Cannot update due date on a settled receivable');
  }

  // Validate date format
  if (dueDate !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      throw new ValidationError('due_date must be in YYYY-MM-DD format');
    }
  }

  // If new due date is in the future and status was Overdue, reset to appropriate status
  let newStatus = receivable.status;
  if (dueDate !== null) {
    const today = new Date().toISOString().slice(0, 10);
    if (dueDate > today && receivable.status === 'Overdue') {
      newStatus = receivable.outstandingAmount < receivable.originalAmount
        ? 'PartiallyPaid'
        : 'Pending';
    }
  }

  await db.query(
    `UPDATE receivables
     SET due_date = $2, status = $3, updated_at = now()
     WHERE id = $1`,
    [id, dueDate, newStatus],
  );

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'receivable', $3, $4, $5)`,
    [
      staffCtx.staffId,
      staffCtx.role,
      String(id),
      staffCtx.branchId,
      JSON.stringify({ action: 'update_due_date', dueDate, previousDueDate: receivable.dueDate }),
    ],
  );

  return getById(id);
}

// ── getSummary ────────────────────────────────────────────────────────────────

export async function getSummary(branchId?: number): Promise<{
  totalOutstanding: number;
  pendingCount: number;
  overdueCount: number;
  partiallyPaidCount: number;
  settledThisMonth: number;
}> {
  const branchCond = branchId ? `WHERE branch_id = $1` : '';
  const params = branchId ? [branchId] : [];

  const result = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN status != 'Settled' THEN outstanding_amount ELSE 0 END), 0)::NUMERIC AS total_outstanding,
       COUNT(CASE WHEN status = 'Pending' THEN 1 END)::INTEGER AS pending_count,
       COUNT(CASE WHEN status = 'Overdue' THEN 1 END)::INTEGER AS overdue_count,
       COUNT(CASE WHEN status = 'PartiallyPaid' THEN 1 END)::INTEGER AS partially_paid_count,
       COUNT(CASE WHEN status = 'Settled'
                   AND date_trunc('month', settlement_date) = date_trunc('month', now())
                  THEN 1 END)::INTEGER AS settled_this_month
     FROM receivables
     ${branchCond}`,
    params,
  );

  const row = result.rows[0];
  return {
    totalOutstanding: parseFloat(row.total_outstanding),
    pendingCount: row.pending_count,
    overdueCount: row.overdue_count,
    partiallyPaidCount: row.partially_paid_count,
    settledThisMonth: row.settled_this_month,
  };
}
