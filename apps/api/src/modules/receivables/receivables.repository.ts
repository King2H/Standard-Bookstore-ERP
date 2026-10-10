import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import { toReceivableRecord, type ReceivableRow } from './receivables.mapper.js';
import type {
  NewReceivable,
  ReceivableFilter,
  ReceivableRecord,
  ReceivableSourceType,
  ReceivableStatus,
  ReceivableSummaryRecord,
} from './receivables.types.js';
import { OPEN_STATUSES } from './receivables.policy.js';

// Receivables are branch-owned (#12): lists and the summary take the branch
// the controller scoped; single records are checked by recordInBranch() on the
// route before they get here.

type Page = { limit: number; offset: number };

function selectReceivables(q: Queryable) {
  return q
    .selectFrom('receivables as r')
    .leftJoin('customers as c', 'c.id', 'r.customer_id')
    .select([
      'r.id',
      'r.source_type',
      'r.source_ref_id',
      'r.source_entity_id',
      'r.customer_id',
      'c.full_name as customer_name',
      'c.customer_code',
      'r.branch_id',
      'r.original_amount',
      'r.outstanding_amount',
      'r.currency',
      sql<string | null>`TO_CHAR(r.due_date, 'YYYY-MM-DD')`.as('due_date'),
      'r.settlement_date',
      'r.status',
      'r.notes',
      'r.written_off_amount',
      'r.written_off_at',
      'r.written_off_by',
      'r.write_off_reason',
      'r.created_at',
      'r.updated_at',
    ]);
}

function toRecord(row: unknown): ReceivableRecord {
  return toReceivableRecord(row as ReceivableRow);
}

/** One receivable; with `forUpdate`, locked until the transaction ends. */
export async function findById(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<ReceivableRecord | undefined> {
  let query = selectReceivables(q).where('r.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('r');
  const row = await query.executeTakeFirst();
  return row && toRecord(row);
}

/** The receivable a sale or exchange opened, locked until the transaction ends. */
export async function lockBySource(
  q: Queryable,
  sourceType: ReceivableSourceType,
  sourceEntityId: number | string,
): Promise<ReceivableRecord | undefined> {
  const row = await selectReceivables(q)
    .where('r.source_type', '=', sourceType)
    .where('r.source_entity_id', '=', String(sourceEntityId))
    .forUpdate('r')
    .executeTakeFirst();
  return row && toRecord(row);
}

export async function list(q: Queryable, filter: ReceivableFilter, page: Page): Promise<{ items: ReceivableRecord[]; total: number }> {
  let query = selectReceivables(q).where('r.branch_id', '=', filter.branchId);
  if (filter.customerId !== undefined) query = query.where('r.customer_id', '=', filter.customerId);
  if (filter.statuses) query = query.where('r.status', 'in', filter.statuses);
  if (filter.overdueOnly) query = query.where('r.status', '=', 'Overdue');
  if (filter.sourceType) query = query.where('r.source_type', '=', filter.sourceType);
  if (filter.dueDateFrom) query = query.where('r.due_date', '>=', sql<Date>`${filter.dueDateFrom}::date`);
  if (filter.dueDateTo) query = query.where('r.due_date', '<=', sql<Date>`${filter.dueDateTo}::date`);

  const [rows, count] = await Promise.all([
    query.orderBy('r.created_at', 'desc').orderBy('r.id', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toRecord), total: Number(count.count) };
}

/** Undefined `branchId`: every branch. Months are the database's calendar. */
export async function summary(q: Queryable, branchId: number | undefined): Promise<ReceivableSummaryRecord> {
  let query = q
    .selectFrom('receivables')
    .select([
      sql<string>`COALESCE(SUM(outstanding_amount) FILTER (WHERE status IN (${sql.join(OPEN_STATUSES)})), 0)`.as('total_outstanding'),
      sql<number>`COUNT(*) FILTER (WHERE status = 'Pending')::int`.as('pending_count'),
      sql<number>`COUNT(*) FILTER (WHERE status = 'Overdue')::int`.as('overdue_count'),
      sql<number>`COUNT(*) FILTER (WHERE status = 'PartiallyPaid')::int`.as('partially_paid_count'),
      sql<number>`COUNT(*) FILTER (WHERE status = 'Settled' AND date_trunc('month', settlement_date) = date_trunc('month', now()))::int`.as('settled_this_month'),
      sql<number>`COUNT(*) FILTER (WHERE status = 'WrittenOff' AND date_trunc('month', written_off_at) = date_trunc('month', now()))::int`.as('written_off_this_month'),
    ]);
  if (branchId !== undefined) query = query.where('branch_id', '=', branchId);
  const row = await query.executeTakeFirstOrThrow();
  return {
    totalOutstanding: Money.of(row.total_outstanding),
    pendingCount: row.pending_count,
    overdueCount: row.overdue_count,
    partiallyPaidCount: row.partially_paid_count,
    settledThisMonth: row.settled_this_month,
    writtenOffThisMonth: row.written_off_this_month,
  };
}

/** Opens a receivable; a source that already has one keeps it. */
export async function insert(q: Queryable, r: NewReceivable): Promise<void> {
  const amount = r.originalAmount.toFixed(2);
  await q
    .insertInto('receivables')
    .values({
      source_type: r.sourceType,
      source_ref_id: r.sourceRefId,
      source_entity_id: String(r.sourceEntityId),
      customer_id: r.customerId,
      branch_id: r.branchId,
      original_amount: amount,
      outstanding_amount: amount,
      currency: 'ETB',
      due_date: r.dueDate === null ? null : sql<Date>`${r.dueDate}::date`,
      status: 'Pending',
      notes: r.notes,
    })
    .onConflict((oc) => oc.columns(['source_type', 'source_entity_id']).doNothing())
    .execute();
}

export async function setBalance(q: Queryable, id: string, outstanding: Money, status: ReceivableStatus): Promise<void> {
  await q
    .updateTable('receivables')
    .set({
      outstanding_amount: outstanding.toFixed(2),
      status,
      settlement_date: status === 'Settled' ? sql<Date>`now()` : null,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', id)
    .execute();
}

export async function writeOff(q: Queryable, id: string, w: { amount: Money; staffId: number; reason: string }): Promise<void> {
  await q
    .updateTable('receivables')
    .set({
      status: 'WrittenOff',
      outstanding_amount: '0',
      written_off_amount: w.amount.toFixed(2),
      written_off_at: sql<Date>`now()`,
      written_off_by: w.staffId,
      write_off_reason: w.reason,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', id)
    .execute();
}

export async function setDueDate(q: Queryable, id: string, dueDate: string | null, status: ReceivableStatus): Promise<void> {
  await q
    .updateTable('receivables')
    .set({
      due_date: dueDate === null ? null : sql<Date>`${dueDate}::date`,
      status,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', id)
    .execute();
}

/** Open receivables whose due date has passed become Overdue; returns how many. */
export async function markOverdue(q: Queryable): Promise<number> {
  const rows = await q
    .updateTable('receivables')
    .set({ status: 'Overdue', updated_at: sql<Date>`now()` })
    .where('status', 'in', ['Pending', 'PartiallyPaid'])
    .where('due_date', '<', sql<Date>`CURRENT_DATE`)
    .returning('id')
    .execute();
  return rows.length;
}

/** Today in the database's calendar, YYYY-MM-DD: the date the overdue job uses. */
export async function today(q: Queryable): Promise<string> {
  const row = await sql<{ today: string }>`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today`.execute(q);
  return row.rows[0].today;
}

/** An order's status; undefined if there is no such order. */
export async function orderStatus(q: Queryable, orderId: number | string): Promise<string | undefined> {
  const row = await q.selectFrom('orders').select('status').where('id', '=', String(orderId)).executeTakeFirst();
  return row?.status ?? undefined;
}

export interface LedgerEntry {
  type: 'payment' | 'write_off';
  receivable: ReceivableRecord;
  idempotencyKey: string;
  amount: Money;
  method: string | null;
  staffId: number;
  meta: Record<string, unknown>;
}

/** A financial_transactions entry for a receivable, booked to the receivable's branch. Returns its id. */
export async function insertLedgerEntry(q: Queryable, e: LedgerEntry): Promise<string> {
  const r = e.receivable;
  const row = await q
    .insertInto('financial_transactions')
    .values({
      type: e.type,
      order_id: r.sourceType === 'order_credit_sale' ? r.sourceEntityId : null,
      exchange_id: r.sourceType === 'exchange_difference' ? r.sourceEntityId : null,
      receivable_id: r.id,
      idempotency_key: e.idempotencyKey,
      amount: e.amount.toFixed(2),
      currency: r.currency,
      method: e.method,
      staff_id: e.staffId,
      branch_id: r.branchId,
      meta: JSON.stringify(e.meta),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return String(row.id);
}

/** An uncleared incoming bank movement, to be matched against the statement. */
export async function insertBankReconciliation(
  q: Queryable,
  e: { bankAccountId: number; paymentRefId: string; amount: Money; notes: string },
): Promise<void> {
  await q
    .insertInto('bank_reconciliation')
    .values({
      bank_account_id: e.bankAccountId,
      payment_ref_id: e.paymentRefId,
      amount: e.amount.toFixed(2),
      direction: 'in',
      status: 'uncleared',
      notes: e.notes,
    })
    .execute();
}
