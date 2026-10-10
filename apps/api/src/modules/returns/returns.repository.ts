import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import {
  toLineRecord,
  toRefundRecord,
  toReturnRecord,
  type RefundRow,
  type ReturnLineRow,
  type ReturnRow,
} from './returns.mapper.js';
import type {
  RefundMethod,
  RefundPart,
  RefundRecord,
  ReturnFilter,
  ReturnLineRecord,
  ReturnRecord,
  SaleForReturn,
  SaleLine,
  Tender,
} from './returns.types.js';

// Returns are branch-owned (#12): lists take the branch the controller scoped;
// single returns are checked by recordInBranch() on the route.

type Page = { limit: number; offset: number };

// ── The sale being returned ───────────────────────────────────────────────────

/**
 * The sale, locked until the transaction ends: returns on one sale run one
 * after another, so each reads what the ones before it took back.
 */
export async function lockSale(q: Queryable, id: number): Promise<SaleForReturn | undefined> {
  const row = await q
    .selectFrom('transactions')
    .select([
      'id',
      'branch_id',
      'location_id',
      'customer_id',
      'status',
      'transaction_number',
      'subtotal',
      'grand_total',
      'amount_paid',
      'amount_due',
      sql<number>`CURRENT_DATE - created_at::date`.as('days_since_sale'),
    ])
    .where('id', '=', String(id))
    .forUpdate()
    .executeTakeFirst();
  return (
    row && {
      id: String(row.id),
      branchId: row.branch_id,
      locationId: row.location_id,
      customerId: row.customer_id,
      status: row.status as SaleForReturn['status'],
      transactionNumber: row.transaction_number,
      subtotal: Money.of(row.subtotal),
      grandTotal: Money.of(row.grand_total),
      amountPaid: Money.of(row.amount_paid),
      amountDue: Money.of(row.amount_due),
      daysSinceSale: Number(row.days_since_sale),
    }
  );
}

/** The sale's lines, with what completed returns already took back from each. */
export async function saleLines(q: Queryable, transactionId: string): Promise<SaleLine[]> {
  const rows = await q
    .selectFrom('transaction_line_items as li')
    .select([
      'li.id',
      'li.book_id',
      'li.quantity',
      'li.unit_price',
      'li.line_total',
      'li.unit_cost',
      sql<string>`COALESCE((
        SELECT SUM(rli.quantity) FROM return_line_items rli JOIN returns r ON r.id = rli.return_id
        WHERE rli.transaction_line_item_id = li.id AND r.status = 'completed'), 0)`.as('returned_quantity'),
      sql<string>`COALESCE((
        SELECT SUM(rli.line_refund_amount) FROM return_line_items rli JOIN returns r ON r.id = rli.return_id
        WHERE rli.transaction_line_item_id = li.id AND r.status = 'completed'), 0)`.as('returned_value'),
    ])
    .where('li.transaction_id', '=', transactionId)
    .orderBy('li.id')
    .execute();
  return rows.map((r) => ({
    id: String(r.id),
    bookId: r.book_id,
    quantity: r.quantity,
    unitPrice: Money.of(r.unit_price),
    lineTotal: Money.of(r.line_total),
    unitCost: r.unit_cost === null ? null : Money.of(r.unit_cost),
    returnedQuantity: Number(r.returned_quantity),
    returnedValue: Money.of(r.returned_value),
  }));
}

/**
 * What each payment method of the sale can still give back: what was paid
 * with it less what earlier returns refunded by it.
 */
export async function tenders(q: Queryable, transactionId: string): Promise<Tender[]> {
  const rows = await q
    .selectFrom('transaction_payments as p')
    .select([
      'p.method',
      sql<string>`SUM(p.amount)`.as('paid'),
      sql<Date>`MAX(p.created_at)`.as('last_paid_at'),
      sql<string>`COALESCE((
        SELECT SUM(f.amount) FROM refunds f JOIN returns r ON r.id = f.return_id
        WHERE r.transaction_id = p.transaction_id AND r.status = 'completed' AND f.method = p.method), 0)`.as('refunded'),
    ])
    .where('p.transaction_id', '=', transactionId)
    .groupBy(['p.method', 'p.transaction_id'])
    .execute();
  return rows.map((r) => ({
    method: r.method as Tender['method'],
    available: Money.of(r.paid).minus(r.refunded),
    lastPaidAt: new Date(r.last_paid_at),
  }));
}

/** What earlier returns gave back of what was paid; credit notes took nothing paid. */
export async function refundedSoFar(q: Queryable, transactionId: string): Promise<Money> {
  const row = await q
    .selectFrom('refunds as f')
    .innerJoin('returns as r', 'r.id', 'f.return_id')
    .select(sql<string>`COALESCE(SUM(f.amount), 0)`.as('total'))
    .where('r.transaction_id', '=', transactionId)
    .where('r.status', '=', 'completed')
    .where('f.method', '<>', 'credit_note')
    .executeTakeFirstOrThrow();
  return Money.of(row.total);
}

/** The loyalty points the sale earned, and how many returns took back so far (a positive number). */
export async function salePoints(q: Queryable, customerId: number, transactionNumber: string): Promise<{ earned: number; reversed: number }> {
  const row = await q
    .selectFrom('loyalty_history')
    .select([
      sql<string>`COALESCE(SUM(points_delta) FILTER (WHERE reason = 'ACCRUAL'), 0)`.as('earned'),
      sql<string>`COALESCE(-SUM(points_delta) FILTER (WHERE reason = 'RETURN_REVERSAL'), 0)`.as('reversed'),
    ])
    .where('customer_id', '=', customerId)
    .where('transaction_ref', '=', transactionNumber)
    .executeTakeFirstOrThrow();
  return { earned: Number(row.earned), reversed: Number(row.reversed) };
}

export async function setSaleDue(q: Queryable, id: string, due: Money, status: 'paid' | 'partial' | 'credit'): Promise<void> {
  await q.updateTable('transactions').set({ amount_due: due.toFixed(2), payment_status: status }).where('id', '=', id).execute();
}

// ── Writing a return ──────────────────────────────────────────────────────────

export async function insertReturn(
  q: Queryable,
  r: {
    returnNumber: string;
    transactionId: string;
    branchId: number;
    customerId: number | null;
    total: Money;
    refundMethod: RefundMethod | 'mixed';
    reason: string | null;
    processedBy: number;
    approvedBy: number | null;
  },
): Promise<string> {
  const row = await q
    .insertInto('returns')
    .values({
      return_number: r.returnNumber,
      transaction_id: r.transactionId,
      branch_id: r.branchId,
      customer_id: r.customerId,
      total_refund_amount: r.total.toFixed(2),
      refund_method: r.refundMethod,
      status: 'completed',
      reason: r.reason,
      processed_by: r.processedBy,
      approved_by: r.approvedBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return String(row.id);
}

export async function insertLine(
  q: Queryable,
  returnId: string,
  line: { transactionLineItemId: string; bookId: number; quantity: number; unitPrice: Money; value: Money },
): Promise<void> {
  await q
    .insertInto('return_line_items')
    .values({
      return_id: returnId,
      transaction_line_item_id: line.transactionLineItemId,
      book_id: line.bookId,
      quantity: line.quantity,
      unit_price: line.unitPrice.toFixed(2),
      line_refund_amount: line.value.toFixed(2),
    })
    .execute();
}

export async function insertRefund(q: Queryable, returnId: string, part: RefundPart): Promise<void> {
  await q.insertInto('refunds').values({ return_id: returnId, method: part.method, amount: part.amount.toFixed(2) }).execute();
}

// ── Reads ─────────────────────────────────────────────────────────────────────

function selectReturns(q: Queryable) {
  return q
    .selectFrom('returns as r')
    .select([
      'r.id',
      'r.return_number',
      'r.transaction_id',
      'r.branch_id',
      'r.customer_id',
      'r.total_refund_amount',
      'r.refund_method',
      'r.status',
      'r.reason',
      'r.processed_by',
      'r.approved_by',
      'r.created_at',
    ]);
}

export async function findReturn(q: Queryable, id: string): Promise<ReturnRecord | undefined> {
  const row = await selectReturns(q).where('r.id', '=', id).executeTakeFirst();
  return row && toReturnRecord(row as ReturnRow);
}

export async function returnLines(q: Queryable, returnId: string): Promise<ReturnLineRecord[]> {
  const rows = await q
    .selectFrom('return_line_items as rli')
    .leftJoin('books as b', 'b.id', 'rli.book_id')
    .select([
      'rli.id',
      'rli.return_id',
      'rli.transaction_line_item_id',
      'rli.book_id',
      'b.title as book_title',
      'rli.quantity',
      'rli.unit_price',
      'rli.line_refund_amount',
    ])
    .where('rli.return_id', '=', returnId)
    .orderBy('rli.id')
    .execute();
  return rows.map((r) => toLineRecord(r as ReturnLineRow));
}

export async function refunds(q: Queryable, returnId: string): Promise<RefundRecord[]> {
  const rows = await q
    .selectFrom('refunds')
    .select(['id', 'return_id', 'method', 'amount', 'created_at'])
    .where('return_id', '=', returnId)
    .orderBy('id')
    .execute();
  return rows.map((r) => toRefundRecord(r as RefundRow));
}

export async function list(q: Queryable, filter: ReturnFilter, page: Page): Promise<{ items: ReturnRecord[]; total: number }> {
  let query = selectReturns(q).where('r.branch_id', '=', filter.branchId);
  if (filter.customerId !== undefined) query = query.where('r.customer_id', '=', filter.customerId);
  if (filter.transactionId !== undefined) query = query.where('r.transaction_id', '=', String(filter.transactionId));
  if (filter.status) query = query.where('r.status', '=', filter.status);
  if (filter.dateFrom) query = query.where('r.created_at', '>=', sql<Date>`${filter.dateFrom}::date`);
  // Through the end of that day.
  if (filter.dateTo) query = query.where('r.created_at', '<', sql<Date>`${filter.dateTo}::date + 1`);

  const [rows, count] = await Promise.all([
    query.orderBy('r.created_at', 'desc').orderBy('r.id', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map((r) => toReturnRecord(r as ReturnRow)), total: Number(count.count) };
}
