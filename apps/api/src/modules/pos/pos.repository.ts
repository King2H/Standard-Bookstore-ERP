import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import {
  toLineRecord,
  toPaymentRecord,
  toTransactionRecord,
  type PosLineRow,
  type PosPaymentRow,
  type PosTransactionRow,
} from './pos.mapper.js';
import type {
  PaymentLine,
  PosFilter,
  PosLineRecord,
  PosPaymentRecord,
  PosPaymentStatus,
  PosTransactionRecord,
  PricedLine,
} from './pos.types.js';

// Sales are branch-owned (#12): lists take the branch the controller scoped;
// single sales are checked by recordInBranch() on the route.

type Page = { limit: number; offset: number };

function selectTransactions(q: Queryable) {
  return q
    .selectFrom('transactions as t')
    .leftJoin('receivables as r', (j) => j.on('r.source_type', '=', 'pos_credit_sale').onRef('r.source_entity_id', '=', 't.id'))
    .select([
      't.id',
      't.branch_id',
      't.location_id',
      't.customer_id',
      't.staff_id',
      't.transaction_number',
      't.subtotal',
      't.discount_total',
      't.tax_total',
      't.grand_total',
      't.amount_paid',
      't.amount_due',
      't.payment_status',
      't.currency',
      't.status',
      't.created_at',
      sql<string>`TO_CHAR(t.created_at, 'YYYY-MM-DD')`.as('sold_on'),
      sql<string>`TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')`.as('today'),
      sql<boolean>`EXISTS (SELECT 1 FROM returns ret WHERE ret.transaction_id = t.id AND ret.status = 'completed')`.as('has_returns'),
      sql<string | null>`TO_CHAR(r.due_date, 'YYYY-MM-DD')`.as('due_date'),
    ]);
}

function toRecord(row: unknown): PosTransactionRecord {
  return toTransactionRecord(row as PosTransactionRow);
}

/** One sale; with `forUpdate`, locked until the transaction ends. */
export async function findTransaction(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<PosTransactionRecord | undefined> {
  let query = selectTransactions(q).where('t.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('t');
  const row = await query.executeTakeFirst();
  return row && toRecord(row);
}

export async function lineItems(q: Queryable, transactionId: string): Promise<PosLineRecord[]> {
  const rows = await q
    .selectFrom('transaction_line_items as li')
    .leftJoin('books as b', 'b.id', 'li.book_id')
    .select([
      'li.id',
      'li.transaction_id',
      'li.book_id',
      'b.title as book_title',
      'b.isbn as book_isbn',
      'li.quantity',
      'li.unit_price',
      'li.discount_pct',
      'li.discount_amount',
      'li.line_total',
      'li.unit_cost',
    ])
    .where('li.transaction_id', '=', transactionId)
    .orderBy('li.id')
    .execute();
  return rows.map((r) => toLineRecord(r as PosLineRow));
}

export async function payments(q: Queryable, transactionId: string): Promise<PosPaymentRecord[]> {
  const rows = await q
    .selectFrom('transaction_payments')
    .select(['id', 'transaction_id', 'method', 'amount', 'reference', 'created_at'])
    .where('transaction_id', '=', transactionId)
    .orderBy('id')
    .execute();
  return rows.map((r) => toPaymentRecord(r as PosPaymentRow));
}

export async function list(q: Queryable, filter: PosFilter, page: Page): Promise<{ items: PosTransactionRecord[]; total: number }> {
  let query = selectTransactions(q).where('t.branch_id', '=', filter.branchId);
  if (filter.customerId !== undefined) query = query.where('t.customer_id', '=', filter.customerId);
  if (filter.staffId !== undefined) query = query.where('t.staff_id', '=', filter.staffId);
  if (filter.status) query = query.where('t.status', '=', filter.status);
  if (filter.paymentStatus) query = query.where('t.payment_status', '=', filter.paymentStatus);
  if (filter.transactionNumber) query = query.where('t.transaction_number', '=', filter.transactionNumber);
  if (filter.dateFrom) query = query.where('t.created_at', '>=', sql<Date>`${filter.dateFrom}::date`);
  // Through the end of that day.
  if (filter.dateTo) query = query.where('t.created_at', '<', sql<Date>`${filter.dateTo}::date + 1`);

  const [rows, count] = await Promise.all([
    query.orderBy('t.created_at', 'desc').orderBy('t.id', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toRecord), total: Number(count.count) };
}

// ── What a sale needs to know ─────────────────────────────────────────────────

export async function isBranchActive(q: Queryable, branchId: number): Promise<boolean> {
  const row = await q.selectFrom('branches').select('is_active').where('id', '=', branchId).executeTakeFirst();
  return row?.is_active === true;
}

export async function isCustomerActive(q: Queryable, customerId: number): Promise<boolean | undefined> {
  const row = await q.selectFrom('customers').select('is_active').where('id', '=', customerId).executeTakeFirst();
  return row?.is_active;
}

export async function customerName(q: Queryable, customerId: number): Promise<string | null> {
  const row = await q.selectFrom('customers').select('full_name').where('id', '=', customerId).executeTakeFirst();
  return row?.full_name ?? null;
}

/** A book with its price in the branch (the branch's own price, else the default); undefined if there is no such book. */
export async function bookForSale(
  q: Queryable,
  bookId: number,
  branchId: number,
): Promise<{ isActive: boolean; price: Money | null } | undefined> {
  const row = await q
    .selectFrom('books as b')
    .leftJoin('book_branch_prices as bbp', (j) =>
      j.onRef('bbp.book_id', '=', 'b.id').on('bbp.branch_id', '=', branchId).on('bbp.format_id', '=', 0).on('bbp.edition_id', '=', 0),
    )
    .select(['b.is_active', sql<string | null>`COALESCE(bbp.price, b.default_price)`.as('price')])
    .where('b.id', '=', bookId)
    .executeTakeFirst();
  return row && { isActive: row.is_active, price: row.price === null ? null : Money.of(row.price) };
}

// ── Writing a sale ────────────────────────────────────────────────────────────

export async function insertTransaction(
  q: Queryable,
  t: {
    branchId: number;
    locationId: number;
    customerId: number | null;
    staffId: number;
    transactionNumber: string;
    subtotal: Money;
    discountTotal: Money;
    taxTotal: Money;
    grandTotal: Money;
    amountPaid: Money;
    amountDue: Money;
    paymentStatus: PosPaymentStatus;
  },
): Promise<string> {
  const row = await q
    .insertInto('transactions')
    .values({
      branch_id: t.branchId,
      location_id: t.locationId,
      customer_id: t.customerId,
      staff_id: t.staffId,
      transaction_number: t.transactionNumber,
      subtotal: t.subtotal.toFixed(2),
      discount_total: t.discountTotal.toFixed(2),
      tax_total: t.taxTotal.toFixed(2),
      grand_total: t.grandTotal.toFixed(2),
      amount_paid: t.amountPaid.toFixed(2),
      amount_due: t.amountDue.toFixed(2),
      payment_status: t.paymentStatus,
      currency: 'ETB',
      status: 'completed',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return String(row.id);
}

export async function insertLine(q: Queryable, transactionId: string, line: PricedLine, unitCost: Money): Promise<void> {
  await q
    .insertInto('transaction_line_items')
    .values({
      transaction_id: transactionId,
      book_id: line.bookId,
      quantity: line.quantity,
      unit_price: line.unitPrice.toFixed(2),
      discount_pct: line.discountPct.toFixed(2),
      discount_amount: line.discountAmount.toFixed(2),
      line_total: line.lineTotal.toFixed(2),
      unit_cost: unitCost.toFixed(2),
    })
    .execute();
}

export async function insertPayment(q: Queryable, transactionId: string, p: PaymentLine): Promise<void> {
  await q
    .insertInto('transaction_payments')
    .values({ transaction_id: transactionId, method: p.method, amount: p.amount.toFixed(2), reference: p.reference })
    .execute();
}

export async function setPaid(q: Queryable, id: string, paid: Money, due: Money, status: PosPaymentStatus): Promise<void> {
  await q
    .updateTable('transactions')
    .set({ amount_paid: paid.toFixed(2), amount_due: due.toFixed(2), payment_status: status })
    .where('id', '=', id)
    .execute();
}

export async function setVoided(q: Queryable, id: string): Promise<void> {
  await q.updateTable('transactions').set({ status: 'voided' }).where('id', '=', id).execute();
}

/** Loyalty points the sale earned (accrued after it), which a void takes back. */
export async function pointsEarned(q: Queryable, customerId: number, transactionNumber: string): Promise<number> {
  const row = await q
    .selectFrom('loyalty_history')
    .select(sql<string | null>`SUM(points_delta)`.as('total'))
    .where('customer_id', '=', customerId)
    .where('transaction_ref', '=', transactionNumber)
    .where('reason', '=', 'ACCRUAL')
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

/** Today in the database's calendar, YYYY-MM-DD. */
export async function today(q: Queryable): Promise<string> {
  const { rows } = await sql<{ today: string }>`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today`.execute(q);
  return rows[0].today;
}

export async function staffName(q: Queryable, staffId: number): Promise<string | null> {
  const row = await q.selectFrom('staff').select('username').where('id', '=', staffId).executeTakeFirst();
  return row?.username ?? null;
}
