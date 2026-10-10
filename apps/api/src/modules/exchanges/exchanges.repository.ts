import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import { toExchangeRecord, type ExchangeRow } from './exchanges.mapper.js';
import type {
  Condition,
  ExchangeFilter,
  ExchangeItemRecord,
  ExchangeRecord,
  RefundMethod,
  SettlementEntryRecord,
  SettlementType,
} from './exchanges.types.js';

// Exchanges are branch-owned (#12): lists take the branch the controller
// scoped; single exchanges are checked by recordInBranch() on the route.

type Page = { limit: number; offset: number };

function selectExchanges(q: Queryable) {
  return q
    .selectFrom('exchanges as e')
    .leftJoin('receivables as r', (j) => j.on('r.source_type', '=', 'exchange_difference').onRef('r.source_entity_id', '=', 'e.id'))
    .select([
      'e.id',
      'e.exchange_reference',
      'e.branch_id',
      'e.location_id',
      'e.customer_id',
      'e.status',
      'e.lifecycle_status',
      'e.total_incoming_value',
      'e.total_outgoing_value',
      'e.net_balance',
      'e.settlement_type',
      'e.refund_method',
      'e.currency',
      'e.notes',
      'e.created_by',
      'e.created_at',
      'e.updated_at',
      'r.outstanding_amount as receivable_outstanding',
      'r.status as receivable_status',
      sql<string | null>`TO_CHAR(r.due_date, 'YYYY-MM-DD')`.as('due_date'),
      sql<string>`TO_CHAR(e.created_at, 'YYYY-MM-DD')`.as('made_on'),
      sql<string>`TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')`.as('today'),
      'e.voided_at',
      'e.voided_by',
      'e.void_reason',
    ]);
}

function toRecord(row: unknown): ExchangeRecord {
  return toExchangeRecord(row as ExchangeRow);
}

/** One exchange; with `forUpdate`, locked until the transaction ends. */
export async function findExchange(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<ExchangeRecord | undefined> {
  let query = selectExchanges(q).where('e.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('e');
  const row = await query.executeTakeFirst();
  return row && toRecord(row);
}

export async function list(q: Queryable, filter: ExchangeFilter, page: Page): Promise<{ items: ExchangeRecord[]; total: number }> {
  let query = selectExchanges(q).where('e.branch_id', '=', filter.branchId);
  if (filter.customerId !== undefined) query = query.where('e.customer_id', '=', filter.customerId);
  if (filter.status) query = query.where('e.status', '=', filter.status);
  if (filter.dateFrom) query = query.where('e.created_at', '>=', sql<Date>`${filter.dateFrom}::date`);
  // Through the end of that day.
  if (filter.dateTo) query = query.where('e.created_at', '<', sql<Date>`${filter.dateTo}::date + 1`);

  const [rows, count] = await Promise.all([
    query.orderBy('e.created_at', 'desc').orderBy('e.id', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toRecord), total: Number(count.count) };
}

/**
 * The exchange's books. Quick Exchanges keep them in the incoming and
 * outgoing tables; exchanges made through the retired lifecycle flow in
 * exchange_items. An exchange has rows in one of the two only.
 */
export async function items(q: Queryable, exchangeId: string): Promise<{ incoming: ExchangeItemRecord[]; outgoing: ExchangeItemRecord[] }> {
  const lifecycle = await q
    .selectFrom('exchange_items as ei')
    .innerJoin('books as b', 'b.id', 'ei.book_id')
    .select(['ei.id', 'ei.exchange_id', 'ei.book_id', 'b.title', 'ei.quantity', 'ei.unit_price', 'ei.total_price', 'ei.type', 'ei.condition', 'ei.unit_cost'])
    .where('ei.exchange_id', '=', exchangeId)
    .orderBy('ei.id')
    .execute();
  if (lifecycle.length > 0) {
    const map = (r: (typeof lifecycle)[number]): ExchangeItemRecord => ({
      id: String(r.id),
      exchangeId: String(r.exchange_id),
      bookId: r.book_id,
      bookTitle: r.title,
      quantity: r.quantity,
      unitPrice: Money.of(r.unit_price),
      totalPrice: Money.of(r.total_price),
      ...(r.type === 'returned' && { condition: r.condition as Condition }),
      unitCost: r.unit_cost === null ? null : Money.of(r.unit_cost),
    });
    return { incoming: lifecycle.filter((r) => r.type === 'returned').map(map), outgoing: lifecycle.filter((r) => r.type === 'new').map(map) };
  }

  const [incoming, outgoing] = await Promise.all([
    q
      .selectFrom('exchange_incoming_items as ei')
      .innerJoin('books as b', 'b.id', 'ei.book_id')
      .select(['ei.id', 'ei.exchange_id', 'ei.book_id', 'b.title', 'ei.quantity', 'ei.evaluated_unit_price', 'ei.total_price', 'ei.condition'])
      .where('ei.exchange_id', '=', exchangeId)
      .orderBy('ei.id')
      .execute(),
    q
      .selectFrom('exchange_outgoing_items as eo')
      .innerJoin('books as b', 'b.id', 'eo.book_id')
      .select(['eo.id', 'eo.exchange_id', 'eo.book_id', 'b.title', 'eo.quantity', 'eo.selling_unit_price', 'eo.total_price', 'eo.unit_cost'])
      .where('eo.exchange_id', '=', exchangeId)
      .orderBy('eo.id')
      .execute(),
  ]);
  return {
    incoming: incoming.map((r) => ({
      id: String(r.id),
      exchangeId: String(r.exchange_id),
      bookId: r.book_id,
      bookTitle: r.title,
      quantity: r.quantity,
      unitPrice: Money.of(r.evaluated_unit_price),
      totalPrice: Money.of(r.total_price),
      condition: r.condition as Condition,
    })),
    outgoing: outgoing.map((r) => ({
      id: String(r.id),
      exchangeId: String(r.exchange_id),
      bookId: r.book_id,
      bookTitle: r.title,
      quantity: r.quantity,
      unitPrice: Money.of(r.selling_unit_price),
      totalPrice: Money.of(r.total_price),
      unitCost: r.unit_cost === null ? null : Money.of(r.unit_cost),
    })),
  };
}

export async function settlementEntries(q: Queryable, exchangeId: string): Promise<SettlementEntryRecord[]> {
  const rows = await q
    .selectFrom('exchange_settlement_entries')
    .select(['id', 'entry_type', 'amount', 'method', 'created_at'])
    .where('exchange_id', '=', exchangeId)
    .orderBy('id')
    .execute();
  return rows.map((r) => ({ id: String(r.id), entryType: r.entry_type, amount: Money.of(r.amount), method: r.method, createdAt: r.created_at }));
}

// ── What an exchange needs to know ────────────────────────────────────────────

/** A book with its price in the branch (the branch's own price, else the default); undefined if there is no such book. */
export async function bookPrice(q: Queryable, bookId: number, branchId: number): Promise<{ isActive: boolean; price: Money | null } | undefined> {
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

export async function isCustomerActive(q: Queryable, customerId: number): Promise<boolean | undefined> {
  const row = await q.selectFrom('customers').select('is_active').where('id', '=', customerId).executeTakeFirst();
  return row?.is_active;
}

export async function today(q: Queryable): Promise<string> {
  const { rows } = await sql<{ today: string }>`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today`.execute(q);
  return rows[0].today;
}

// ── Writing an exchange ───────────────────────────────────────────────────────

export async function insertExchange(
  q: Queryable,
  e: {
    reference: string;
    branchId: number;
    locationId: number;
    customerId: number | null;
    totalIncoming: Money;
    totalOutgoing: Money;
    net: Money;
    settlementType: SettlementType;
    refundMethod: RefundMethod | null;
    notes: string | null;
    createdBy: number;
  },
): Promise<string> {
  const row = await q
    .insertInto('exchanges')
    .values({
      exchange_reference: e.reference,
      branch_id: e.branchId,
      location_id: e.locationId,
      customer_id: e.customerId,
      status: 'Completed',
      total_incoming_value: e.totalIncoming.toFixed(2),
      total_outgoing_value: e.totalOutgoing.toFixed(2),
      net_balance: e.net.toFixed(2),
      settlement_type: e.settlementType,
      refund_method: e.refundMethod,
      currency: 'ETB',
      notes: e.notes,
      created_by: e.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return String(row.id);
}

export async function insertIncoming(
  q: Queryable,
  exchangeId: string,
  i: { bookId: number; quantity: number; unitValue: Money; condition: Condition },
): Promise<void> {
  await q
    .insertInto('exchange_incoming_items')
    .values({
      exchange_id: exchangeId,
      book_id: i.bookId,
      quantity: i.quantity,
      evaluated_unit_price: i.unitValue.toFixed(2),
      total_price: i.unitValue.times(i.quantity).toFixed(2),
      condition: i.condition,
    })
    .execute();
}

export async function insertOutgoing(
  q: Queryable,
  exchangeId: string,
  o: { bookId: number; quantity: number; price: Money; unitCost: Money },
): Promise<void> {
  await q
    .insertInto('exchange_outgoing_items')
    .values({
      exchange_id: exchangeId,
      book_id: o.bookId,
      quantity: o.quantity,
      selling_unit_price: o.price.toFixed(2),
      total_price: o.price.times(o.quantity).toFixed(2),
      unit_cost: o.unitCost.toFixed(2),
    })
    .execute();
}

export async function insertEntry(
  q: Queryable,
  e: { exchangeId: string; entryType: 'cash_payment' | 'cash_refund'; amount: Money; method: string; note: string | null; by: number },
): Promise<void> {
  await q
    .insertInto('exchange_settlement_entries')
    .values({
      exchange_id: e.exchangeId,
      entry_type: e.entryType,
      amount: e.amount.toFixed(2),
      currency: 'ETB',
      method: e.method,
      note: e.note,
      authorised_by: e.by,
    })
    .execute();
}

export async function setVoided(q: Queryable, id: string, by: number, reason: string): Promise<void> {
  await q
    .updateTable('exchanges')
    .set({ status: 'Cancelled', voided_at: sql<Date>`now()`, voided_by: by, void_reason: reason, updated_at: sql`now()` })
    .where('id', '=', id)
    .execute();
}
