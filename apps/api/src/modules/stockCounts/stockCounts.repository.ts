import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import type { StockCountFilter, StockCountLineRecord, StockCountRecord, StockCountScope, StockCountStatus } from './stockCounts.types.js';

// Stock counts belong to a branch (#172): lists take the branch the
// controller scoped; single counts are checked by recordInBranch() on the
// route and by the service for each action.

type Page = { limit: number; offset: number };

function selectCounts(q: Queryable) {
  return q
    .selectFrom('stock_counts as c')
    .innerJoin('locations as l', 'l.id', 'c.location_id')
    .innerJoin('staff as cs', 'cs.id', 'c.created_by')
    .leftJoin('staff as ps', 'ps.id', 'c.posted_by')
    .select([
      'c.id', 'c.count_number', 'c.branch_id', 'c.location_id', 'l.name as location_name', 'c.scope', 'c.status', 'c.notes',
      'c.created_by', 'cs.full_name as created_by_name', 'c.created_at', 'c.submitted_at', 'c.posted_by',
      'ps.full_name as posted_by_name', 'c.posted_at', 'c.cancelled_at', 'c.cancel_reason',
      sql<string>`(SELECT count(*) FROM stock_count_lines x WHERE x.count_id = c.id)`.as('line_count'),
      sql<string>`(SELECT count(*) FROM stock_count_lines x WHERE x.count_id = c.id AND x.counted_quantity IS NOT NULL)`.as('counted_lines'),
    ]);
}

type CountRow = Awaited<ReturnType<ReturnType<typeof selectCounts>['executeTakeFirstOrThrow']>>;

function toRecord(r: CountRow): StockCountRecord {
  return {
    id: r.id,
    countNumber: r.count_number,
    branchId: r.branch_id,
    locationId: r.location_id,
    locationName: r.location_name,
    scope: r.scope as StockCountScope,
    status: r.status as StockCountStatus,
    notes: r.notes,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    postedBy: r.posted_by,
    postedByName: r.posted_by_name,
    postedAt: r.posted_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    lineCount: Number(r.line_count),
    countedLines: Number(r.counted_lines),
  };
}

/** One count; with `forUpdate`, locked until the transaction ends, so two people acting on it take turns. */
export async function findCount(q: Queryable, id: number, opts: { forUpdate?: boolean } = {}): Promise<StockCountRecord | undefined> {
  let query = selectCounts(q).where('c.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('c');
  const row = await query.executeTakeFirst();
  return row && toRecord(row);
}

/** The count still open (counting or submitted) at a location, if any. */
export async function openCountAt(q: Queryable, locationId: number): Promise<number | undefined> {
  const row = await q.selectFrom('stock_counts').select('id').where('location_id', '=', locationId)
    .where('status', 'in', ['counting', 'submitted']).executeTakeFirst();
  return row?.id;
}

export async function list(q: Queryable, filter: StockCountFilter, page: Page): Promise<{ items: StockCountRecord[]; total: number }> {
  let query = selectCounts(q).where('c.branch_id', '=', filter.branchId);
  if (filter.status) query = query.where('c.status', '=', filter.status);
  if (filter.locationId) query = query.where('c.location_id', '=', filter.locationId);
  const [rows, count] = await Promise.all([
    query.orderBy('c.created_at', 'desc').orderBy('c.id', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toRecord), total: Number(count.count) };
}

export async function lines(q: Queryable, countId: number): Promise<StockCountLineRecord[]> {
  const rows = await q
    .selectFrom('stock_count_lines as sl')
    .innerJoin('stock_counts as c', 'c.id', 'sl.count_id')
    .innerJoin('books as b', 'b.id', 'sl.book_id')
    .leftJoin('staff as st', 'st.id', 'sl.counted_by')
    .leftJoin('inventory as i', (j) => j.onRef('i.book_id', '=', 'sl.book_id').onRef('i.location_id', '=', 'c.location_id'))
    .select([
      'sl.id', 'sl.book_id', 'b.title', 'b.isbn', 'sl.frozen_quantity', 'sl.expected_quantity', 'sl.counted_quantity',
      'sl.counted_by', 'st.full_name as counted_by_name', 'sl.counted_at', 'sl.recount_requested', 'sl.posted_delta', 'sl.posted_unit_cost',
      sql<string>`COALESCE(i.average_cost, 0)`.as('average_cost'),
      sql<number[]>`COALESCE((SELECT array_agg(e.quantity ORDER BY e.id) FROM stock_count_entries e WHERE e.line_id = sl.id), '{}')`.as('counts'),
    ])
    .where('sl.count_id', '=', countId)
    .orderBy('b.title')
    .orderBy('sl.id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    bookId: r.book_id,
    bookTitle: r.title,
    isbn: r.isbn,
    frozenQuantity: r.frozen_quantity,
    expectedQuantity: r.expected_quantity,
    countedQuantity: r.counted_quantity,
    countedBy: r.counted_by,
    countedByName: r.counted_by_name,
    countedAt: r.counted_at,
    counts: r.counts.map(Number),
    recountRequested: r.recount_requested,
    averageCost: Money.of(r.average_cost),
    postedDelta: r.posted_delta,
    postedUnitCost: r.posted_unit_cost === null ? null : Money.of(r.posted_unit_cost),
  }));
}

export async function insertCount(
  q: Queryable,
  c: { countNumber: string; branchId: number; locationId: number; scope: StockCountScope; notes: string | null; createdBy: number },
): Promise<number> {
  const row = await q
    .insertInto('stock_counts')
    .values({ count_number: c.countNumber, branch_id: c.branchId, location_id: c.locationId, scope: c.scope, notes: c.notes, created_by: c.createdBy })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The lines of a full count: every book with stock recorded at the location, at what it holds now. */
export async function insertLocationLines(q: Queryable, countId: number, locationId: number): Promise<void> {
  await sql`
    INSERT INTO stock_count_lines (count_id, book_id, frozen_quantity)
    SELECT ${countId}, i.book_id, i.quantity FROM inventory i JOIN books b ON b.id = i.book_id
    WHERE i.location_id = ${locationId} AND (i.quantity <> 0 OR b.is_active)`.execute(q);
}

export async function insertLine(q: Queryable, countId: number, bookId: number, frozenQuantity: number): Promise<number> {
  const row = await q
    .insertInto('stock_count_lines')
    .values({ count_id: countId, book_id: bookId, frozen_quantity: frozenQuantity })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function findLine(q: Queryable, countId: number, bookId: number): Promise<number | undefined> {
  const row = await q.selectFrom('stock_count_lines').select('id').where('count_id', '=', countId).where('book_id', '=', bookId).executeTakeFirst();
  return row?.id;
}

/** A count of the book: it replaces the last, which stays among the entries. */
export async function recordCount(q: Queryable, lineId: number, c: { quantity: number; expected: number; staffId: number }): Promise<void> {
  await q
    .updateTable('stock_count_lines')
    .set({ counted_quantity: c.quantity, expected_quantity: c.expected, counted_by: c.staffId, counted_at: sql`now()`, recount_requested: false })
    .where('id', '=', lineId)
    .execute();
  await q.insertInto('stock_count_entries').values({ line_id: lineId, quantity: c.quantity, expected_quantity: c.expected, staff_id: c.staffId }).execute();
}

export async function requestRecount(q: Queryable, countId: number, bookIds: number[]): Promise<number> {
  const result = await q.updateTable('stock_count_lines').set({ recount_requested: true })
    .where('count_id', '=', countId).where('book_id', 'in', bookIds).executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function setPosted(q: Queryable, lineId: number, delta: number, unitCost: Money | null): Promise<void> {
  await q.updateTable('stock_count_lines')
    .set({ posted_delta: delta, posted_unit_cost: unitCost === null ? null : unitCost.toFixed(4) })
    .where('id', '=', lineId).execute();
}

export async function setStatus(
  q: Queryable,
  id: number,
  status: StockCountStatus,
  by: { staffId: number; reason?: string } | null = null,
): Promise<void> {
  const set =
    status === 'submitted' ? { status, submitted_at: sql<Date>`now()` }
    : status === 'posted' ? { status, posted_by: by!.staffId, posted_at: sql<Date>`now()` }
    : status === 'cancelled' ? { status, cancelled_by: by!.staffId, cancelled_at: sql<Date>`now()`, cancel_reason: by!.reason ?? null }
    : { status };
  await q.updateTable('stock_counts').set(set).where('id', '=', id).execute();
}

export async function locationBranch(q: Queryable, locationId: number): Promise<number | undefined> {
  const row = await q.selectFrom('locations').select('branch_id').where('id', '=', locationId).executeTakeFirst();
  return row?.branch_id;
}

export async function missingBooks(q: Queryable, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const found = await q.selectFrom('books').select('id').where('id', 'in', ids).execute();
  const have = new Set(found.map((b) => b.id));
  return ids.filter((id) => !have.has(id));
}
