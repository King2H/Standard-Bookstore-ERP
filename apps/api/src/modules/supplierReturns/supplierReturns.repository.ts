import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import type {
  OrderLine, ReturnLineInput, SupplierReturnFilter, SupplierReturnLineRecord, SupplierReturnRecord, SupplierReturnSource, SupplierReturnStatus,
} from './supplierReturns.types.js';

// A return belongs to the order's receiving branch, where the copies leave
// from (#173); the ordering branch reads it too. Lists take the branch the
// controller scoped; single returns are checked by recordInBranch() on the
// route and by the service for each action.

type Page = { limit: number; offset: number };

function selectReturns(q: Queryable) {
  return q
    .selectFrom('supplier_returns as r')
    .innerJoin('purchase_orders as po', 'po.id', 'r.po_id')
    .innerJoin('suppliers as s', 's.id', 'r.supplier_id')
    .innerJoin('staff as cs', 'cs.id', 'r.created_by')
    .leftJoin('staff as ss', 'ss.id', 'r.sent_by')
    .leftJoin('supplier_credit_notes as cn', 'cn.id', 'r.credit_note_id')
    .select([
      'r.id', 'r.return_number', 'r.po_id', 'r.branch_id', 'r.supplier_id', 's.name as supplier_name', 'r.status', 'r.notes',
      'r.created_by', 'cs.full_name as created_by_name', 'r.created_at', 'r.sent_by', 'ss.full_name as sent_by_name', 'r.sent_at',
      'r.cancelled_at', 'r.cancel_reason', 'cn.credit_note_number',
      sql<string>`(SELECT count(*) FROM supplier_return_lines x WHERE x.return_id = r.id)`.as('line_count'),
      sql<string>`(SELECT COALESCE(SUM(x.quantity), 0) FROM supplier_return_lines x WHERE x.return_id = r.id)`.as('total_quantity'),
      sql<string>`(SELECT COALESCE(ROUND(SUM(x.quantity * x.unit_credit), 2), 0) FROM supplier_return_lines x WHERE x.return_id = r.id)`.as('credit_value'),
      sql<string | null>`CASE WHEN r.status = 'sent'
        THEN (SELECT COALESCE(ROUND(SUM(x.quantity * x.unit_cost), 2), 0) FROM supplier_return_lines x WHERE x.return_id = r.id) END`.as('cost_value'),
    ]);
}

type ReturnRow = Awaited<ReturnType<ReturnType<typeof selectReturns>['executeTakeFirstOrThrow']>>;

function toRecord(r: ReturnRow): SupplierReturnRecord {
  return {
    id: r.id,
    returnNumber: r.return_number,
    poId: String(r.po_id),
    branchId: r.branch_id,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    status: r.status as SupplierReturnStatus,
    notes: r.notes,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    sentBy: r.sent_by,
    sentByName: r.sent_by_name,
    sentAt: r.sent_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    lineCount: Number(r.line_count),
    totalQuantity: Number(r.total_quantity),
    creditValue: Money.of(r.credit_value),
    costValue: r.cost_value === null ? null : Money.of(r.cost_value),
    creditNoteNumber: r.credit_note_number,
  };
}

/** One return; with `forUpdate`, locked until the transaction ends, so two people acting on it take turns. */
export async function findReturn(q: Queryable, id: number, opts: { forUpdate?: boolean } = {}): Promise<SupplierReturnRecord | undefined> {
  let query = selectReturns(q).where('r.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('r');
  const row = await query.executeTakeFirst();
  return row && toRecord(row);
}

export async function list(q: Queryable, filter: SupplierReturnFilter, page: Page): Promise<{ items: SupplierReturnRecord[]; total: number }> {
  let query = selectReturns(q).where((eb) => eb.or([eb('r.branch_id', '=', filter.branchId), eb('po.branch_id', '=', filter.branchId)]));
  if (filter.status) query = query.where('r.status', '=', filter.status);
  if (filter.poId !== undefined) query = query.where('r.po_id', '=', String(filter.poId));
  const [rows, count] = await Promise.all([
    query.orderBy('r.created_at', 'desc').orderBy('r.id', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toRecord), total: Number(count.count) };
}

export async function lines(q: Queryable, returnId: number): Promise<SupplierReturnLineRecord[]> {
  const rows = await q
    .selectFrom('supplier_return_lines as rl')
    .innerJoin('books as b', 'b.id', 'rl.book_id')
    .innerJoin('locations as l', 'l.id', 'rl.location_id')
    .select([
      'rl.id', 'rl.po_line_item_id', 'rl.book_id', 'b.title', 'b.isbn', 'rl.location_id', 'l.name as location_name', 'rl.source',
      'rl.quantity', 'rl.unit_credit', 'rl.unit_cost',
    ])
    .where('rl.return_id', '=', returnId)
    .orderBy('rl.id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    poLineItemId: String(r.po_line_item_id),
    bookId: r.book_id,
    bookTitle: r.title,
    isbn: r.isbn,
    locationId: r.location_id,
    locationName: r.location_name,
    source: r.source as SupplierReturnSource,
    quantity: r.quantity,
    unitCredit: Money.of(r.unit_credit),
    unitCost: r.unit_cost === null ? null : Money.of(r.unit_cost),
  }));
}

/** The order's lines, by id. */
export async function orderLines(q: Queryable, poId: string): Promise<Map<string, OrderLine>> {
  const rows = await q.selectFrom('po_line_items').select(['id', 'book_id', 'unit_cost', 'received_quantity']).where('po_id', '=', poId).execute();
  return new Map(rows.map((r) => [String(r.id), { id: String(r.id), bookId: r.book_id, unitCost: Money.of(r.unit_cost), receivedQuantity: r.received_quantity }]));
}

/** Copies of each order line already sent back. */
export async function sentQuantities(q: Queryable, poId: string): Promise<Map<string, number>> {
  const rows = await q
    .selectFrom('supplier_return_lines as rl')
    .innerJoin('supplier_returns as r', 'r.id', 'rl.return_id')
    .select(['rl.po_line_item_id', (eb) => eb.fn.sum<string>('rl.quantity').as('quantity')])
    .where('r.po_id', '=', poId)
    .where('r.status', '=', 'sent')
    .groupBy('rl.po_line_item_id')
    .execute();
  return new Map(rows.map((r) => [String(r.po_line_item_id), Number(r.quantity)]));
}

export async function insertReturn(
  q: Queryable,
  r: { returnNumber: string; poId: string; branchId: number; supplierId: number; notes: string | null; createdBy: number },
): Promise<number> {
  const row = await q
    .insertInto('supplier_returns')
    .values({ return_number: r.returnNumber, po_id: r.poId, branch_id: r.branchId, supplier_id: r.supplierId, notes: r.notes, created_by: r.createdBy })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A draft's lines, replacing any it had, each at the order's price. */
export async function replaceLines(q: Queryable, returnId: number, input: ReturnLineInput[], orderLines: Map<string, OrderLine>): Promise<void> {
  await q.deleteFrom('supplier_return_lines').where('return_id', '=', returnId).execute();
  await q
    .insertInto('supplier_return_lines')
    .values(input.map((l) => {
      const line = orderLines.get(String(l.poLineItemId))!;
      return {
        return_id: returnId, po_line_item_id: line.id, book_id: line.bookId, location_id: l.locationId, source: l.source,
        quantity: l.quantity, unit_credit: line.unitCost.toFixed(4),
      };
    }))
    .execute();
}

export async function setNotes(q: Queryable, id: number, notes: string | null): Promise<void> {
  await q.updateTable('supplier_returns').set({ notes }).where('id', '=', id).execute();
}

export async function setLineCost(q: Queryable, lineId: number, unitCost: Money): Promise<void> {
  await q.updateTable('supplier_return_lines').set({ unit_cost: unitCost.toFixed(4) }).where('id', '=', lineId).execute();
}

export async function setSent(q: Queryable, id: number, by: number, creditNoteId: number | null): Promise<void> {
  await q.updateTable('supplier_returns').set({ status: 'sent', sent_by: by, sent_at: sql<Date>`now()`, credit_note_id: creditNoteId }).where('id', '=', id).execute();
}

export async function setCancelled(q: Queryable, id: number, by: number, reason: string): Promise<void> {
  await q
    .updateTable('supplier_returns')
    .set({ status: 'cancelled', cancelled_by: by, cancelled_at: sql<Date>`now()`, cancel_reason: reason })
    .where('id', '=', id)
    .execute();
}
