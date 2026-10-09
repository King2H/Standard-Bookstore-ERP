import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import {
  toStockLevelRecord,
  toStockMovementRecord,
  type StockLevelRow,
  type StockMovementRow,
} from './inventory.mapper.js';
import type {
  BookAvailabilityRecord,
  LocationStockRecord,
  LockedLevel,
  StockLevelFilter,
  StockLevelRecord,
  StockMovementFilter,
  StockMovementRecord,
  NewStockMovement,
} from './inventory.types.js';

// Stock is branch-owned through its location: every list takes the branch.
// Single rows are addressed by (book, location); the routes and the services
// that move stock check that the location is in the session's branch first.

type Page = { limit: number; offset: number };

const DEFAULT_REORDER_POINT = 5;

/** Units held for confirmed, unfulfilled orders. */
const reservedUnits = sql<number>`COALESCE((
  SELECT SUM(r.quantity) FROM inventory_reservations r
  WHERE r.book_id = i.book_id AND r.location_id = i.location_id AND r.status = 'reserved'
), 0)::int`;

function fromLevels(q: Queryable) {
  return q
    .selectFrom('inventory as i')
    .innerJoin('locations as l', 'l.id', 'i.location_id')
    .innerJoin('books as b', 'b.id', 'i.book_id');
}

const LEVEL_COLUMNS = [
  'i.book_id',
  'b.title as book_title',
  'b.isbn as book_isbn',
  'b.is_active as book_is_active',
  'i.location_id',
  'l.name as location_name',
  'l.branch_id',
  'i.quantity',
  reservedUnits.as('reserved'),
  'i.reorder_point',
  'i.version',
  'i.updated_at',
] as const;

function filterLevels(q: Queryable, filter: StockLevelFilter) {
  let query = fromLevels(q).where('l.branch_id', '=', filter.branchId);
  if (filter.locationId !== undefined) query = query.where('i.location_id', '=', filter.locationId);
  if (filter.bookId !== undefined) query = query.where('i.book_id', '=', filter.bookId);
  if (filter.lowStockOnly) query = query.whereRef('i.quantity', '<=', 'i.reorder_point');
  if (filter.statuses) query = query.where('b.status', 'in', filter.statuses);
  else if (filter.isActive !== undefined) query = query.where('b.is_active', '=', filter.isActive);
  if (filter.q) {
    const pattern = `%${filter.q.trim()}%`;
    query = query.where((eb) => eb.or([eb('b.title', 'ilike', pattern), eb('b.isbn', 'like', pattern)]));
  }
  return query;
}

async function pageOfLevels(
  q: Queryable,
  filter: StockLevelFilter,
  order: (query: ReturnType<typeof selectFiltered>) => ReturnType<typeof selectFiltered>,
  page: Page,
): Promise<{ items: StockLevelRecord[]; total: number }> {
  const [items, count] = await Promise.all([
    order(selectFiltered(q, filter)).limit(page.limit).offset(page.offset).execute(),
    filterLevels(q, filter)
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow(),
  ]);
  return { items: items.map((r) => toStockLevelRecord(r as StockLevelRow)), total: Number(count.count) };
}

function selectFiltered(q: Queryable, filter: StockLevelFilter) {
  return filterLevels(q, filter).select(LEVEL_COLUMNS);
}

export function listLevels(
  q: Queryable,
  filter: StockLevelFilter,
  page: Page,
): Promise<{ items: StockLevelRecord[]; total: number }> {
  const dir = filter.sortDir === 'desc' ? 'desc' : 'asc';
  return pageOfLevels(
    q,
    filter,
    (query) =>
      filter.sortBy === 'updatedAt'
        ? query.orderBy('i.updated_at', dir).orderBy('b.title', 'asc')
        : query.orderBy('b.title', dir).orderBy('l.name', 'asc'),
    page,
  );
}

/** Active books at or below their reorder point, emptiest first. */
export function lowStock(q: Queryable, branchId: number, page: Page): Promise<{ items: StockLevelRecord[]; total: number }> {
  return pageOfLevels(
    q,
    { branchId, lowStockOnly: true, isActive: true },
    (query) => query.orderBy('i.quantity', 'asc').orderBy('b.title', 'asc'),
    page,
  );
}

export async function findLevel(q: Queryable, bookId: number, locationId: number): Promise<StockLevelRecord | undefined> {
  const row = await fromLevels(q)
    .select(LEVEL_COLUMNS)
    .where('i.book_id', '=', bookId)
    .where('i.location_id', '=', locationId)
    .executeTakeFirst();
  return row && toStockLevelRecord(row as StockLevelRow);
}

/** Creates an empty stock row for the book at the location, unless there is one. */
export async function ensureLevel(q: Queryable, bookId: number, locationId: number): Promise<void> {
  await q
    .insertInto('inventory')
    .values({ book_id: bookId, location_id: locationId, quantity: 0, reorder_point: DEFAULT_REORDER_POINT, version: 0 })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/** Locks the stock row until the end of the transaction. */
export async function lockLevel(q: Queryable, bookId: number, locationId: number): Promise<LockedLevel | undefined> {
  const row = await q
    .selectFrom('inventory')
    .select(['quantity', 'version', 'reorder_point', 'average_cost'])
    .where('book_id', '=', bookId)
    .where('location_id', '=', locationId)
    .forUpdate()
    .executeTakeFirst();
  return (
    row && {
      quantity: row.quantity,
      version: row.version,
      reorderPoint: row.reorder_point,
      averageCost: Money.of(row.average_cost),
    }
  );
}

/** Locks the rows of a book at several locations, in id order so two transfers cannot deadlock. */
export async function lockLevels(q: Queryable, bookId: number, locationIds: number[]): Promise<void> {
  await q
    .selectFrom('inventory')
    .select('location_id')
    .where('book_id', '=', bookId)
    .where('location_id', 'in', locationIds)
    .orderBy('location_id')
    .forUpdate()
    .execute();
}

/** Sets the quantity (and the average cost, when given) and bumps the version. */
export async function updateLevel(
  q: Queryable,
  bookId: number,
  locationId: number,
  level: { quantity: number; averageCost?: Money },
): Promise<void> {
  await q
    .updateTable('inventory')
    .set((eb) => ({
      quantity: level.quantity,
      ...(level.averageCost && { average_cost: level.averageCost.toFixed(4) }),
      version: eb('version', '+', 1),
      updated_at: sql`now()`,
    }))
    .where('book_id', '=', bookId)
    .where('location_id', '=', locationId)
    .execute();
}

/** False when there is no stock row for the book at the location. */
export async function setReorderPoint(
  q: Queryable,
  bookId: number,
  locationId: number,
  reorderPoint: number,
): Promise<boolean> {
  const result = await q
    .updateTable('inventory')
    .set({ reorder_point: reorderPoint, updated_at: sql`now()` })
    .where('book_id', '=', bookId)
    .where('location_id', '=', locationId)
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

export async function insertMovement(q: Queryable, movement: NewStockMovement): Promise<void> {
  const units = Math.abs(movement.qtyAfter - movement.qtyBefore);
  await q
    .insertInto('inventory_history')
    .values({
      book_id: movement.bookId,
      location_id: movement.locationId,
      qty_before: movement.qtyBefore,
      qty_after: movement.qtyAfter,
      delta: movement.qtyAfter - movement.qtyBefore,
      reason_code: movement.reasonCode,
      movement_type: movement.movementType,
      reference_type: movement.referenceType,
      reference_id: movement.referenceId === null ? null : String(movement.referenceId),
      notes: movement.notes,
      staff_id: movement.staffId,
      unit_cost: movement.unitCost?.toFixed(2) ?? null,
      total_cost: movement.unitCost?.times(units).toFixed(2) ?? null,
    })
    .execute();
}

/** One id shared by the two rows of a transfer, from the history's own sequence. */
export async function nextTransferId(q: Queryable): Promise<string> {
  const { rows } = await sql<{ id: string }>`SELECT nextval('inventory_history_id_seq')::text AS id`.execute(q);
  return rows[0].id;
}

/** Marks an order's reservations as fulfilled; its stock left when it was confirmed. */
export async function deductReservations(q: Queryable, orderId: number | string): Promise<void> {
  await q
    .updateTable('inventory_reservations')
    .set({ status: 'deducted', updated_at: sql`now()` })
    .where('order_id', '=', String(orderId))
    .where('status', '=', 'reserved')
    .execute();
}

/** Stock of several books at one location, for the sale and exchange screens. */
export async function availability(q: Queryable, bookIds: number[], locationId: number): Promise<BookAvailabilityRecord[]> {
  if (bookIds.length === 0) return [];
  const rows = await q
    .selectFrom('inventory as i')
    .innerJoin('locations as l', 'l.id', 'i.location_id')
    .select(['i.book_id', 'i.location_id', 'l.name as location_name', 'i.quantity', reservedUnits.as('reserved')])
    .where('i.book_id', 'in', bookIds)
    .where('i.location_id', '=', locationId)
    .execute();
  return rows.map((r) => ({
    bookId: r.book_id,
    locationId: r.location_id,
    locationName: r.location_name,
    quantity: r.quantity,
    reserved: Number(r.reserved),
  }));
}

function filterMovements(q: Queryable, filter: StockMovementFilter) {
  let query = q
    .selectFrom('inventory_history as ih')
    .innerJoin('locations as l', 'l.id', 'ih.location_id')
    .where('l.branch_id', '=', filter.branchId);
  if (filter.bookId !== undefined) query = query.where('ih.book_id', '=', filter.bookId);
  if (filter.locationId !== undefined) query = query.where('ih.location_id', '=', filter.locationId);
  if (filter.movementType !== undefined) query = query.where('ih.movement_type', '=', filter.movementType);
  if (filter.reasonCode !== undefined) query = query.where('ih.reason_code', '=', filter.reasonCode);
  if (filter.dateFrom !== undefined) query = query.where('ih.created_at', '>=', sql<Date>`${filter.dateFrom}`);
  if (filter.dateTo !== undefined) query = query.where('ih.created_at', '<=', sql<Date>`${filter.dateTo}`);
  return query;
}

/** Stock movements in a branch, newest first. */
export async function movements(
  q: Queryable,
  filter: StockMovementFilter,
  page: Page,
): Promise<{ items: StockMovementRecord[]; total: number }> {
  const [items, count] = await Promise.all([
    filterMovements(q, filter)
      .innerJoin('books as b', 'b.id', 'ih.book_id')
      .innerJoin('staff as s', 's.id', 'ih.staff_id')
      .select([
        'ih.id',
        'ih.book_id',
        'b.title as book_title',
        'ih.location_id',
        'l.name as location_name',
        'ih.qty_before',
        'ih.qty_after',
        'ih.delta',
        'ih.movement_type',
        'ih.reason_code',
        'ih.reference_type',
        'ih.reference_id',
        'ih.notes',
        'ih.staff_id',
        's.username as staff_username',
        'ih.created_at',
      ])
      .orderBy('ih.created_at', 'desc')
      .orderBy('ih.id', 'desc')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    filterMovements(q, filter)
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow(),
  ]);
  return { items: items.map((r) => toStockMovementRecord(r as StockMovementRow)), total: Number(count.count) };
}

/** Where a book is in stock: one entry per location, in one branch or all. */
export async function stockByLocation(
  q: Queryable,
  bookId: number,
  branchId: number | undefined,
): Promise<LocationStockRecord[]> {
  let query = q
    .selectFrom('inventory as i')
    .innerJoin('locations as l', 'l.id', 'i.location_id')
    .select([
      'i.location_id',
      'l.name as location_name',
      'l.branch_id',
      'i.quantity',
      reservedUnits.as('reserved'),
      sql<number>`COALESCE(i.damaged_quantity, 0)::int`.as('damaged'),
    ])
    .where('i.book_id', '=', bookId);
  if (branchId !== undefined) query = query.where('l.branch_id', '=', branchId);
  const rows = await query.orderBy('l.name').execute();
  return rows.map((r) => ({
    locationId: r.location_id,
    locationName: r.location_name,
    branchId: r.branch_id,
    quantity: r.quantity,
    reserved: Number(r.reserved),
    damaged: Number(r.damaged),
  }));
}
