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
export type ReceivableSourceType = 'pos_credit_sale' | 'exchange_difference';

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
          ? row.due_date.toISOString().slice(0, 10)
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
    newOutstandingAmount: number;
    isFullySettled: boolean;
  },
  client: PoolClient,
): Promise<void> {
  if (opts.isFullySettled) {
    await client.query(
      `UPDATE receivables
       SET status = 'Settled',
           outstanding_amount = 0,
           settlement_date = now(),
           updated_at = now()
       WHERE source_type = $1
         AND source_entity_id = $2
         AND status != 'Settled'`,
      [opts.sourceType, opts.sourceEntityId],
    );
  } else {
    const outstanding = Math.max(0, opts.newOutstandingAmount);
    await client.query(
      `UPDATE receivables
       SET status = CASE
             WHEN $3 > 0 THEN 'PartiallyPaid'
             ELSE status
           END,
           outstanding_amount = $3,
           updated_at = now()
       WHERE source_type = $1
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
  if (opts.status)      { params.push(opts.status);      conditions.push(`r.status = $${params.length}`); }
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

// ── manualSettle (admin override) ─────────────────────────────────────────────

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
