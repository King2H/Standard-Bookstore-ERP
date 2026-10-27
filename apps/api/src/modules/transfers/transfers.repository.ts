import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import type {
  TransferEventKind,
  TransferEventRecord,
  TransferFilter,
  TransferLineRecord,
  TransferRecord,
  TransferStatus,
} from './transfers.types.js';

// Transfer notes belong to the sending and the receiving branch (#170): lists
// take the branch the controller scoped; single notes are checked by
// recordInBranch() on the route and by transfers.policy for each action.

type Page = { limit: number; offset: number };

// What is still on the way, valued at the cost it left at (decision 3a).
const OUTSTANDING = sql<number>`(tl.quantity - tl.received_quantity - tl.lost_quantity - tl.damaged_quantity - tl.returned_quantity)`;

function selectTransfers(q: Queryable) {
  return q
    .selectFrom('branch_transfers as t')
    .innerJoin('branches as fb', 'fb.id', 't.from_branch_id')
    .innerJoin('branches as tb', 'tb.id', 't.to_branch_id')
    .innerJoin('locations as fl', 'fl.id', 't.from_location_id')
    .innerJoin('staff as cs', 'cs.id', 't.created_by')
    .select([
      't.id',
      't.transfer_number',
      't.from_branch_id',
      'fb.name as from_branch_name',
      't.from_location_id',
      'fl.name as from_location_name',
      't.to_branch_id',
      'tb.name as to_branch_name',
      't.status',
      't.notes',
      't.created_by',
      'cs.full_name as created_by_name',
      't.created_at',
      't.dispatched_by',
      't.dispatched_at',
      't.cancelled_by',
      't.cancelled_at',
      't.completed_at',
      sql<string>`COALESCE((SELECT SUM(tl.quantity) FROM branch_transfer_lines tl WHERE tl.transfer_id = t.id), 0)`.as('total_quantity'),
      sql<string>`ROUND(COALESCE((SELECT SUM(${OUTSTANDING} * tl.unit_cost) FROM branch_transfer_lines tl WHERE tl.transfer_id = t.id), 0), 2)`.as(
        'in_transit_value',
      ),
    ]);
}

type TransferRow = Awaited<ReturnType<ReturnType<typeof selectTransfers>['executeTakeFirstOrThrow']>>;

function toRecord(r: TransferRow): TransferRecord {
  return {
    id: r.id,
    transferNumber: r.transfer_number,
    fromBranchId: r.from_branch_id,
    fromBranchName: r.from_branch_name,
    fromLocationId: r.from_location_id,
    fromLocationName: r.from_location_name,
    toBranchId: r.to_branch_id,
    toBranchName: r.to_branch_name,
    status: r.status as TransferStatus,
    notes: r.notes,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    dispatchedBy: r.dispatched_by,
    dispatchedAt: r.dispatched_at,
    cancelledBy: r.cancelled_by,
    cancelledAt: r.cancelled_at,
    completedAt: r.completed_at,
    totalQuantity: Number(r.total_quantity),
    inTransitValue: Money.of(r.in_transit_value),
  };
}

/** One note; with `forUpdate`, locked until the transaction ends, so two people acting on it take turns. */
export async function findTransfer(q: Queryable, id: number, opts: { forUpdate?: boolean } = {}): Promise<TransferRecord | undefined> {
  let query = selectTransfers(q).where('t.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('t');
  const row = await query.executeTakeFirst();
  return row && toRecord(row);
}

export async function list(q: Queryable, filter: TransferFilter, page: Page): Promise<{ items: TransferRecord[]; total: number }> {
  let query = selectTransfers(q);
  if (filter.direction === 'outgoing') query = query.where('t.from_branch_id', '=', filter.branchId);
  else if (filter.direction === 'incoming') query = query.where('t.to_branch_id', '=', filter.branchId);
  else query = query.where((eb) => eb.or([eb('t.from_branch_id', '=', filter.branchId), eb('t.to_branch_id', '=', filter.branchId)]));
  if (filter.status) query = query.where('t.status', '=', filter.status);

  const [rows, count] = await Promise.all([
    query.orderBy('t.created_at', 'desc').orderBy('t.id', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toRecord), total: Number(count.count) };
}

function selectLines(q: Queryable) {
  return q
    .selectFrom('branch_transfer_lines as tl')
    .innerJoin('books as b', 'b.id', 'tl.book_id')
    .select([
      'tl.id',
      'tl.transfer_id',
      'tl.book_id',
      'b.title',
      'b.isbn',
      'tl.quantity',
      'tl.unit_cost',
      'tl.received_quantity',
      'tl.lost_quantity',
      'tl.damaged_quantity',
      'tl.returned_quantity',
    ]);
}

function toLine(r: Awaited<ReturnType<ReturnType<typeof selectLines>['executeTakeFirstOrThrow']>>): TransferLineRecord {
  return {
    id: r.id,
    transferId: r.transfer_id,
    bookId: r.book_id,
    bookTitle: r.title,
    isbn: r.isbn || null,
    quantity: r.quantity,
    unitCost: r.unit_cost === null ? null : Money.of(r.unit_cost),
    receivedQuantity: r.received_quantity,
    lostQuantity: r.lost_quantity,
    damagedQuantity: r.damaged_quantity,
    returnedQuantity: r.returned_quantity,
  };
}

export async function lines(q: Queryable, transferId: number): Promise<TransferLineRecord[]> {
  const rows = await selectLines(q).where('tl.transfer_id', '=', transferId).orderBy('tl.id').execute();
  return rows.map(toLine);
}

/** One line, locked; the caller holds the note's lock too. */
export async function lockLine(q: Queryable, lineId: number): Promise<TransferLineRecord | undefined> {
  const row = await selectLines(q).where('tl.id', '=', lineId).forUpdate('tl').executeTakeFirst();
  return row && toLine(row);
}

export async function events(q: Queryable, transferId: number): Promise<TransferEventRecord[]> {
  const rows = await q
    .selectFrom('branch_transfer_events as e')
    .innerJoin('branch_transfer_lines as tl', 'tl.id', 'e.line_id')
    .innerJoin('books as b', 'b.id', 'tl.book_id')
    .innerJoin('staff as s', 's.id', 'e.staff_id')
    .leftJoin('locations as l', 'l.id', 'e.location_id')
    .select(['e.id', 'e.line_id', 'b.title', 'e.kind', 'e.quantity', 'e.location_id', 'l.name as location_name', 'e.reason', 'e.staff_id', 's.full_name', 'e.created_at'])
    .where('e.transfer_id', '=', transferId)
    .orderBy('e.id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    lineId: r.line_id,
    bookTitle: r.title,
    kind: r.kind as TransferEventKind,
    quantity: r.quantity,
    locationId: r.location_id,
    locationName: r.location_name,
    reason: r.reason,
    staffId: r.staff_id,
    staffName: r.full_name,
    createdAt: r.created_at,
  }));
}

// ── Writes ────────────────────────────────────────────────────────────────────

export async function insertTransfer(
  q: Queryable,
  t: { transferNumber: string; fromBranchId: number; fromLocationId: number; toBranchId: number; notes: string | null; createdBy: number },
): Promise<number> {
  const row = await q
    .insertInto('branch_transfers')
    .values({
      transfer_number: t.transferNumber,
      from_branch_id: t.fromBranchId,
      from_location_id: t.fromLocationId,
      to_branch_id: t.toBranchId,
      notes: t.notes,
      created_by: t.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A draft's destination, source and notes. */
export async function updateDraft(
  q: Queryable,
  id: number,
  t: { fromLocationId: number; toBranchId: number; notes: string | null },
): Promise<void> {
  await q
    .updateTable('branch_transfers')
    .set({ from_location_id: t.fromLocationId, to_branch_id: t.toBranchId, notes: t.notes, updated_at: sql`now()` })
    .where('id', '=', id)
    .execute();
}

/** A draft's lines, replaced whole. */
export async function replaceLines(q: Queryable, transferId: number, items: Array<{ bookId: number; quantity: number }>): Promise<void> {
  await q.deleteFrom('branch_transfer_lines').where('transfer_id', '=', transferId).execute();
  await q
    .insertInto('branch_transfer_lines')
    .values(items.map((l) => ({ transfer_id: transferId, book_id: l.bookId, quantity: l.quantity })))
    .execute();
}

export async function setStatus(
  q: Queryable,
  id: number,
  status: TransferStatus,
  by: { dispatched?: number; cancelled?: number; completed?: boolean } = {},
): Promise<void> {
  await q
    .updateTable('branch_transfers')
    .set({
      status,
      updated_at: sql`now()`,
      ...(by.dispatched !== undefined && { dispatched_by: by.dispatched, dispatched_at: sql`now()` }),
      ...(by.cancelled !== undefined && { cancelled_by: by.cancelled, cancelled_at: sql`now()` }),
      ...(by.completed && { completed_at: sql`now()` }),
    })
    .where('id', '=', id)
    .execute();
}

export async function setUnitCost(q: Queryable, lineId: number, unitCost: Money): Promise<void> {
  await q.updateTable('branch_transfer_lines').set({ unit_cost: unitCost.toFixed(4) }).where('id', '=', lineId).execute();
}

const COUNTER = {
  received: 'received_quantity',
  lost: 'lost_quantity',
  damaged: 'damaged_quantity',
  returned: 'returned_quantity',
} as const;

/** A receipt or resolution: the event, and the line's count of that kind. */
export async function recordEvent(
  q: Queryable,
  e: { transferId: number; lineId: number; kind: TransferEventKind; quantity: number; locationId: number | null; reason: string | null; staffId: number },
): Promise<void> {
  const column = COUNTER[e.kind];
  await q
    .updateTable('branch_transfer_lines')
    .set((eb) => ({ [column]: eb(column, '+', e.quantity) }))
    .where('id', '=', e.lineId)
    .execute();
  await q
    .insertInto('branch_transfer_events')
    .values({
      transfer_id: e.transferId,
      line_id: e.lineId,
      kind: e.kind,
      quantity: e.quantity,
      location_id: e.locationId,
      reason: e.reason,
      staff_id: e.staffId,
    })
    .execute();
}

// ── Lookups ───────────────────────────────────────────────────────────────────

export async function branch(q: Queryable, id: number): Promise<{ isActive: boolean } | undefined> {
  const row = await q.selectFrom('branches').select('is_active').where('id', '=', id).executeTakeFirst();
  return row && { isActive: row.is_active };
}

export async function locationBranch(q: Queryable, locationId: number): Promise<number | undefined> {
  const row = await q.selectFrom('locations').select('branch_id').where('id', '=', locationId).executeTakeFirst();
  return row?.branch_id;
}

/** The books among `ids` that are not active in the catalog. */
export async function inactiveBooks(q: Queryable, ids: number[]): Promise<number[]> {
  const active = await q.selectFrom('books').select('id').where('id', 'in', ids).where('is_active', '=', true).execute();
  const found = new Set(active.map((r) => r.id));
  return ids.filter((id) => !found.has(id));
}
