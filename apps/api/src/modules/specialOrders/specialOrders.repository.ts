import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import type { LockedLine, OpenLineRecord, OpenLink, PoBookLine } from './specialOrders.types.js';

// All SQL of special orders (#174): the links between order lines and
// purchase orders, and what a special-order line still has on order. A
// line's copies are on order until reserved, delivered or cancelled.

const OPEN_ORDER = sql.raw(`o.status IN ('CONFIRMED', 'PAID', 'PART_DELIVERED', 'Confirmed', 'In_Progress')`);

/** Copies of line `oli` cancelled undelivered with the rest of its order. */
const CANCELLED = sql`COALESCE((SELECT SUM(rli.quantity) FROM return_line_items rli JOIN returns r ON r.id = rli.return_id
  WHERE rli.order_line_item_id = oli.id AND r.status = 'completed' AND r.undelivered), 0)`;
const ON_ORDER = sql`GREATEST(0, oli.quantity - oli.qty_reserved - oli.qty_fulfilled - ${CANCELLED})`;
/** Copies of line `oli` on purchase orders still to arrive. */
const LINKED = sql`COALESCE((SELECT SUM(l.quantity - l.reserved_quantity) FROM special_order_links l
  WHERE l.order_line_item_id = oli.id AND l.released_at IS NULL), 0)`;

/** The branch's special-order lines with copies on order, oldest order first. */
export async function openLines(
  q: Queryable,
  branchId: number,
  opts: { toOrderOnly: boolean; limit: number; offset: number },
): Promise<{ items: OpenLineRecord[]; total: number }> {
  const where = sql`o.branch_id = ${branchId} AND oli.special_order AND ${OPEN_ORDER} AND ${ON_ORDER} > 0
    ${opts.toOrderOnly ? sql`AND ${ON_ORDER} > ${LINKED}` : sql``}`;
  const { rows } = await sql<{
    id: string; order_id: string; order_number: string; created_at: Date; customer_id: number | null; customer_name: string | null;
    book_id: number; title: string; isbn: string | null; quantity: number; on_order: number; linked: number;
    pos: Array<{ poId: string; quantity: number; reserved: number }>;
  }>`
    SELECT oli.id::text, o.id::text AS order_id, o.order_number, o.created_at, o.customer_id, c.full_name AS customer_name,
           oli.book_id, b.title, b.isbn, oli.quantity, ${ON_ORDER}::int AS on_order, ${LINKED}::int AS linked,
           COALESCE((SELECT json_agg(json_build_object('poId', l.po_id::text, 'quantity', l.quantity, 'reserved', l.reserved_quantity) ORDER BY l.id)
                     FROM special_order_links l WHERE l.order_line_item_id = oli.id AND l.released_at IS NULL), '[]') AS pos
    FROM order_line_items oli
    JOIN orders o ON o.id = oli.order_id
    JOIN books b ON b.id = oli.book_id
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE ${where}
    ORDER BY o.created_at, oli.id
    LIMIT ${opts.limit} OFFSET ${opts.offset}`.execute(q);
  const { rows: [count] } = await sql<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM order_line_items oli JOIN orders o ON o.id = oli.order_id WHERE ${where}`.execute(q);
  return {
    total: count.n,
    items: rows.map((r) => ({
      orderLineId: r.id, orderId: r.order_id, orderNumber: r.order_number, orderedAt: r.created_at, customerId: r.customer_id,
      customerName: r.customer_name, bookId: r.book_id, bookTitle: r.title, isbn: r.isbn, quantity: r.quantity,
      onOrder: r.on_order, linked: Math.min(r.linked, r.on_order), purchaseOrders: r.pos,
    })),
  };
}

/** An order line with its order, the line locked; undefined when it is not of the branch. */
export async function lockLine(q: Queryable, lineId: string | number, branchId: number): Promise<LockedLine | undefined> {
  const { rows: [r] } = await sql<{
    id: string; order_id: string; order_number: string; status: string; branch_id: number; location_id: number | null;
    book_id: number; title: string; special_order: boolean; on_order: number; linked: number;
  }>`
    SELECT oli.id::text, o.id::text AS order_id, o.order_number, o.status, o.branch_id, o.location_id, oli.book_id, b.title,
           oli.special_order, ${ON_ORDER}::int AS on_order, ${LINKED}::int AS linked
    FROM order_line_items oli JOIN orders o ON o.id = oli.order_id JOIN books b ON b.id = oli.book_id
    WHERE oli.id = ${String(lineId)} AND o.branch_id = ${branchId}
    FOR UPDATE OF oli`.execute(q);
  return r && {
    id: r.id, orderId: r.order_id, orderNumber: r.order_number, orderStatus: r.status, branchId: r.branch_id, locationId: r.location_id,
    bookId: r.book_id, bookTitle: r.title, specialOrder: r.special_order, onOrder: r.on_order, linked: r.linked,
  };
}

/** Adds `quantity` copies of a line to a purchase order's link, or links it; a released link takes them afresh. */
export async function addLink(q: Queryable, l: { orderLineId: string; poId: string; quantity: number; createdBy: number }): Promise<void> {
  await sql`
    INSERT INTO special_order_links (order_line_item_id, po_id, quantity, created_by)
    VALUES (${l.orderLineId}, ${l.poId}, ${l.quantity}, ${l.createdBy})
    ON CONFLICT (order_line_item_id, po_id) DO UPDATE SET
      quantity = CASE WHEN special_order_links.released_at IS NULL THEN special_order_links.quantity ELSE special_order_links.reserved_quantity END
                 + EXCLUDED.quantity,
      released_at = NULL`.execute(q);
}

/** A purchase order's links not released, oldest order first: what it brings for which order. */
export async function linksOf(q: Queryable, poId: string): Promise<Array<{
  bookId: number; orderLineId: string; orderId: string; orderNumber: string; quantity: number; reserved: number;
}>> {
  const rows = await q
    .selectFrom('special_order_links as l')
    .innerJoin('order_line_items as oli', 'oli.id', 'l.order_line_item_id')
    .innerJoin('orders as o', 'o.id', 'oli.order_id')
    .select(['oli.book_id', 'l.order_line_item_id', 'o.id as order_id', 'o.order_number', 'l.quantity', 'l.reserved_quantity'])
    .where('l.po_id', '=', poId)
    .where('l.released_at', 'is', null)
    .orderBy('o.created_at')
    .orderBy('l.id')
    .execute();
  return rows.map((r) => ({
    bookId: r.book_id, orderLineId: String(r.order_line_item_id), orderId: String(r.order_id), orderNumber: r.order_number,
    quantity: r.quantity, reserved: r.reserved_quantity,
  }));
}

/** Per book, the copies a purchase order still has to bring for its linked lines. */
export async function linkedByBook(q: Queryable, poId: string): Promise<Map<number, number>> {
  const { rows } = await sql<{ book_id: number; n: number }>`
    SELECT oli.book_id, SUM(l.quantity - l.reserved_quantity)::int AS n
    FROM special_order_links l JOIN order_line_items oli ON oli.id = l.order_line_item_id
    WHERE l.po_id = ${poId} AND l.released_at IS NULL
    GROUP BY oli.book_id`.execute(q);
  return new Map(rows.map((r) => [r.book_id, r.n]));
}

/** A purchase order's line for a book, if it has one. */
export async function poLineForBook(q: Queryable, poId: string, bookId: number): Promise<PoBookLine | undefined> {
  const row = await q
    .selectFrom('po_line_items')
    .select(['id', 'quantity', 'received_quantity', 'unit_cost'])
    .where('po_id', '=', poId)
    .where('book_id', '=', bookId)
    .orderBy('id')
    .forUpdate()
    .executeTakeFirst();
  return row && { id: String(row.id), quantity: row.quantity, receivedQuantity: row.received_quantity, unitCost: Money.of(row.unit_cost) };
}

export async function growPoLine(q: Queryable, lineId: string, quantity: number): Promise<void> {
  await q.updateTable('po_line_items').set((eb) => ({ quantity: eb('quantity', '+', quantity) })).where('id', '=', lineId).execute();
}

export async function insertPoLine(q: Queryable, poId: string, l: { bookId: number; quantity: number; unitCost: Money }): Promise<void> {
  await q.insertInto('po_line_items').values({ po_id: poId, book_id: l.bookId, quantity: l.quantity, unit_cost: l.unitCost.toFixed(2) }).execute();
}

/** A purchase order's total from its lines, as procurement prices it. */
export async function retotalPo(q: Queryable, poId: string): Promise<void> {
  await sql`
    UPDATE purchase_orders SET total_amount = (SELECT ROUND(COALESCE(SUM(quantity * unit_cost), 0), 2) FROM po_line_items WHERE po_id = ${poId}),
      updated_at = now()
    WHERE id = ${poId}`.execute(q);
}

/** A purchase order's links still to bring copies of a book, oldest order first, locked. */
export async function openLinks(q: Queryable, poId: string, bookId: number): Promise<OpenLink[]> {
  const { rows } = await sql<{
    id: number; order_line_item_id: string; order_id: string; order_number: string; branch_id: number; location_id: number | null; outstanding: number;
  }>`
    SELECT l.id, l.order_line_item_id::text, o.id::text AS order_id, o.order_number, o.branch_id, o.location_id,
           LEAST(l.quantity - l.reserved_quantity, ${ON_ORDER})::int AS outstanding
    FROM special_order_links l
    JOIN order_line_items oli ON oli.id = l.order_line_item_id
    JOIN orders o ON o.id = oli.order_id
    WHERE l.po_id = ${poId} AND oli.book_id = ${bookId} AND l.released_at IS NULL AND l.quantity > l.reserved_quantity AND ${OPEN_ORDER}
    ORDER BY o.created_at, l.id
    FOR UPDATE OF l, oli`.execute(q);
  return rows.filter((r) => r.outstanding > 0).map((r) => ({
    id: r.id, orderLineId: r.order_line_item_id, orderId: r.order_id, orderNumber: r.order_number,
    branchId: r.branch_id, locationId: r.location_id, outstanding: r.outstanding,
  }));
}

export async function addReserved(q: Queryable, linkId: number, quantity: number): Promise<void> {
  await q.updateTable('special_order_links').set((eb) => ({ reserved_quantity: eb('reserved_quantity', '+', quantity) })).where('id', '=', linkId).execute();
}

/**
 * Copies of a line reserved from stock count against its links still to
 * arrive, oldest first, so those purchase orders bring them as stock.
 */
export async function consumeLinks(q: Queryable, lineId: string, quantity: number): Promise<void> {
  const links = await q
    .selectFrom('special_order_links')
    .select(['id', 'quantity', 'reserved_quantity'])
    .where('order_line_item_id', '=', lineId)
    .where('released_at', 'is', null)
    .orderBy('id')
    .forUpdate()
    .execute();
  let left = quantity;
  for (const l of links) {
    const take = Math.min(left, l.quantity - l.reserved_quantity);
    if (take <= 0) continue;
    await addReserved(q, l.id, take);
    left -= take;
    if (left === 0) break;
  }
}

/** Releases the links of order lines: what they had not reserved arrives as stock. */
export async function releaseForLines(q: Queryable, lineIds: string[]): Promise<void> {
  if (lineIds.length === 0) return;
  await q.updateTable('special_order_links').set({ released_at: sql`now()` })
    .where('order_line_item_id', 'in', lineIds).where('released_at', 'is', null).execute();
}

/** Releases a purchase order's links: the lines go back to be bought. */
export async function releaseForPo(q: Queryable, poId: string): Promise<void> {
  await q.updateTable('special_order_links').set({ released_at: sql`now()` }).where('po_id', '=', poId).where('released_at', 'is', null).execute();
}

export async function bookTitle(q: Queryable, bookId: number): Promise<string> {
  return (await q.selectFrom('books').select('title').where('id', '=', bookId).executeTakeFirst())?.title ?? `Book ${bookId}`;
}

export async function locationName(q: Queryable, locationId: number): Promise<string> {
  return (await q.selectFrom('locations').select('name').where('id', '=', locationId).executeTakeFirst())?.name ?? `Location ${locationId}`;
}
