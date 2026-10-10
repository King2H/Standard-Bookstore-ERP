import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import { toPurchaseOrderRecord, type PurchaseOrderRow } from './procurement.mapper.js';
import type {
  CreditNoteRecord,
  FinancialStatus,
  LineRecord,
  NewLine,
  PaymentTerms,
  PurchaseOrderChanges,
  PurchaseOrderFilter,
  PurchaseOrderRecord,
  PurchaseOrderStatus,
  ReceiptRecord,
  SupplierPaymentRecord,
} from './procurement.types.js';

// Purchase orders belong to their ordering and their receiving branch (#12):
// lists take the branch the controller scoped; single orders are checked by
// recordInBranch() on the route and by procurement.policy for each action.

type Page = { limit: number; offset: number };

function selectOrders(q: Queryable) {
  return q
    .selectFrom('purchase_orders as po')
    .innerJoin('suppliers as s', 's.id', 'po.supplier_id')
    .leftJoin('locations as rl', 'rl.id', 'po.receiving_location_id')
    .select([
      'po.id',
      'po.branch_id',
      'po.supplier_id',
      's.name as supplier_name',
      'po.status',
      'po.total_amount',
      'po.currency',
      sql<string | null>`TO_CHAR(po.expected_delivery_date, 'YYYY-MM-DD')`.as('expected_delivery_date'),
      'po.notes',
      sql<number>`COALESCE(po.receiving_branch_id, po.branch_id)`.as('receiving_branch_id'),
      'po.receiving_location_id',
      'rl.name as receiving_location_name',
      'po.financial_status',
      'po.payment_terms',
      'po.created_by',
      'po.approved_by',
      'po.closed_reason',
      'po.closed_by',
      'po.closed_at',
      'po.created_at',
      'po.updated_at',
      sql<string>`COALESCE((SELECT SUM(li.received_quantity * li.unit_cost) FROM po_line_items li WHERE li.po_id = po.id), 0)`.as('received_value'),
      sql<string>`COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.po_id = po.id), 0)`.as('amount_paid'),
      sql<string>`COALESCE((SELECT SUM(cn.amount) FROM supplier_credit_notes cn WHERE cn.po_id = po.id), 0)`.as('credit_notes_total'),
      sql<string>`COALESCE((SELECT SUM(li.quantity) FROM po_line_items li WHERE li.po_id = po.id), 0)`.as('ordered_quantity_total'),
      sql<string>`COALESCE((SELECT SUM(li.received_quantity) FROM po_line_items li WHERE li.po_id = po.id), 0)`.as('received_quantity_total'),
    ]);
}

function toRecord(row: unknown): PurchaseOrderRecord {
  return toPurchaseOrderRecord(row as PurchaseOrderRow);
}

/** One order; with `forUpdate`, locked until the transaction ends. */
export async function findOrder(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<PurchaseOrderRecord | undefined> {
  let query = selectOrders(q).where('po.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('po');
  const row = await query.executeTakeFirst();
  return row && toRecord(row);
}

export async function list(q: Queryable, filter: PurchaseOrderFilter, page: Page): Promise<{ items: PurchaseOrderRecord[]; total: number }> {
  let query = selectOrders(q).where((eb) =>
    eb.or([
      eb('po.branch_id', '=', filter.branchId),
      eb(sql<number>`COALESCE(po.receiving_branch_id, po.branch_id)`, '=', filter.branchId),
    ]),
  );
  if (filter.status) query = query.where('po.status', '=', filter.status);
  if (filter.supplierId !== undefined) query = query.where('po.supplier_id', '=', filter.supplierId);
  if (filter.dateFrom) query = query.where('po.created_at', '>=', sql<Date>`${filter.dateFrom}::date`);
  // Through the end of that day.
  if (filter.dateTo) query = query.where('po.created_at', '<', sql<Date>`${filter.dateTo}::date + 1`);

  const [rows, count] = await Promise.all([
    query.orderBy('po.created_at', 'desc').orderBy('po.id', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toRecord), total: Number(count.count) };
}

export async function lineItems(q: Queryable, poId: string): Promise<LineRecord[]> {
  const rows = await q
    .selectFrom('po_line_items as li')
    .innerJoin('books as b', 'b.id', 'li.book_id')
    .select([
      'li.id',
      'li.po_id',
      'li.book_id',
      'b.title',
      'b.isbn',
      'li.format_id',
      'li.edition_id',
      'li.quantity',
      'li.unit_cost',
      'li.received_quantity',
    ])
    .where('li.po_id', '=', poId)
    .orderBy('li.id')
    .execute();
  return rows.map((r) => ({
    id: String(r.id),
    poId: String(r.po_id),
    bookId: r.book_id,
    bookTitle: r.title,
    bookIsbn: r.isbn,
    formatId: r.format_id,
    editionId: r.edition_id,
    quantity: r.quantity,
    unitCost: Money.of(r.unit_cost),
    receivedQuantity: r.received_quantity,
  }));
}

export async function receipts(q: Queryable, poId: string): Promise<ReceiptRecord[]> {
  const [heads, items] = await Promise.all([
    q
      .selectFrom('po_receipts as r')
      .innerJoin('locations as l', 'l.id', 'r.location_id')
      .select(['r.id', 'r.po_id', 'r.location_id', 'l.name', 'r.received_by', 'r.received_at', 'r.notes'])
      .where('r.po_id', '=', poId)
      .orderBy('r.received_at')
      .orderBy('r.id')
      .execute(),
    q
      .selectFrom('po_receipt_items as ri')
      .innerJoin('po_receipts as r', 'r.id', 'ri.receipt_id')
      .innerJoin('po_line_items as li', 'li.id', 'ri.po_line_item_id')
      .innerJoin('books as b', 'b.id', 'li.book_id')
      .select(['ri.id', 'ri.receipt_id', 'ri.po_line_item_id', 'b.title', 'ri.quantity_received'])
      .where('r.po_id', '=', poId)
      .orderBy('ri.id')
      .execute(),
  ]);
  return heads.map((h) => ({
    id: String(h.id),
    poId: String(h.po_id),
    locationId: h.location_id,
    locationName: h.name,
    receivedBy: h.received_by,
    receivedAt: h.received_at,
    notes: h.notes,
    items: items
      .filter((i) => String(i.receipt_id) === String(h.id))
      .map((i) => ({
        id: String(i.id),
        receiptId: String(i.receipt_id),
        poLineItemId: String(i.po_line_item_id),
        bookTitle: i.title,
        quantityReceived: i.quantity_received,
      })),
  }));
}

export async function payments(q: Queryable, poId: string): Promise<SupplierPaymentRecord[]> {
  const rows = await q
    .selectFrom('supplier_payments')
    .select(['id', 'po_id', 'amount', 'payment_method', 'source', 'notes', 'created_by', 'created_at'])
    .where('po_id', '=', poId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({
    id: String(r.id),
    poId: String(r.po_id),
    amount: Money.of(r.amount),
    paymentMethod: r.payment_method,
    source: r.source as SupplierPaymentRecord['source'],
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

export async function creditNotes(q: Queryable, poId: string): Promise<CreditNoteRecord[]> {
  const rows = await q
    .selectFrom('supplier_credit_notes')
    .select(['id', 'po_id', 'supplier_id', 'amount', 'reason', 'created_by', 'created_at'])
    .where('po_id', '=', poId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({
    id: String(r.id),
    poId: String(r.po_id),
    supplierId: r.supplier_id,
    amount: Money.of(r.amount),
    reason: r.reason,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

// ── What an order needs to know ───────────────────────────────────────────────

export async function isBookActive(q: Queryable, bookId: number): Promise<boolean> {
  const row = await q.selectFrom('books').select('is_active').where('id', '=', bookId).executeTakeFirst();
  return row?.is_active === true;
}

/** Undefined if there is no such branch. */
export async function isBranchActive(q: Queryable, branchId: number): Promise<boolean | undefined> {
  const row = await q.selectFrom('branches').select('is_active').where('id', '=', branchId).executeTakeFirst();
  return row?.is_active;
}

export async function locationBranch(q: Queryable, locationId: number): Promise<number | undefined> {
  const row = await q.selectFrom('locations').select('branch_id').where('id', '=', locationId).executeTakeFirst();
  return row?.branch_id;
}

export async function defaultLocation(q: Queryable, branchId: number): Promise<number | null> {
  const row = await q
    .selectFrom('locations')
    .select('id')
    .where('branch_id', '=', branchId)
    .where('is_default_fulfillment', '=', true)
    .orderBy('id')
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function supplierName(q: Queryable, supplierId: number): Promise<string> {
  const row = await q.selectFrom('suppliers').select('name').where('id', '=', supplierId).executeTakeFirst();
  return row?.name ?? String(supplierId);
}

export async function hasReceipts(q: Queryable, poId: string): Promise<boolean> {
  const row = await q.selectFrom('po_receipts').select('id').where('po_id', '=', poId).limit(1).executeTakeFirst();
  return row !== undefined;
}

// ── Writing an order ──────────────────────────────────────────────────────────

export async function insertOrder(
  q: Queryable,
  po: {
    branchId: number;
    supplierId: number;
    total: Money;
    expectedDeliveryDate: string | null;
    notes: string | null;
    createdBy: number;
    receivingBranchId: number;
    receivingLocationId: number | null;
    paymentTerms: PaymentTerms;
  },
): Promise<string> {
  const row = await q
    .insertInto('purchase_orders')
    .values({
      branch_id: po.branchId,
      supplier_id: po.supplierId,
      status: 'draft',
      total_amount: po.total.toFixed(2),
      currency: 'ETB',
      expected_delivery_date: po.expectedDeliveryDate,
      notes: po.notes,
      created_by: po.createdBy,
      receiving_branch_id: po.receivingBranchId,
      receiving_location_id: po.receivingLocationId,
      payment_terms: po.paymentTerms,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return String(row.id);
}

export async function replaceLines(q: Queryable, poId: string, lines: NewLine[]): Promise<void> {
  await q.deleteFrom('po_line_items').where('po_id', '=', poId).execute();
  await q
    .insertInto('po_line_items')
    .values(
      lines.map((l) => ({
        po_id: poId,
        book_id: l.bookId,
        format_id: l.formatId,
        edition_id: l.editionId,
        quantity: l.quantity,
        unit_cost: l.unitCost.toFixed(2),
      })),
    )
    .execute();
}

export async function updateOrder(
  q: Queryable,
  id: string,
  ch: Omit<PurchaseOrderChanges, 'lineItems'> & { total?: Money },
): Promise<void> {
  await q
    .updateTable('purchase_orders')
    .set({
      ...(ch.supplierId !== undefined && { supplier_id: ch.supplierId }),
      ...(ch.receivingBranchId !== undefined && ch.receivingBranchId !== null && { receiving_branch_id: ch.receivingBranchId }),
      ...(ch.receivingLocationId !== undefined && { receiving_location_id: ch.receivingLocationId }),
      ...(ch.expectedDeliveryDate !== undefined && { expected_delivery_date: ch.expectedDeliveryDate }),
      ...(ch.notes !== undefined && { notes: ch.notes }),
      ...(ch.paymentTerms !== undefined && { payment_terms: ch.paymentTerms }),
      ...(ch.total !== undefined && { total_amount: ch.total.toFixed(2) }),
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .execute();
}

export async function setStatus(
  q: Queryable,
  id: string,
  status: PurchaseOrderStatus,
  extra: { approvedBy?: number | null; closed?: { by: number; reason: string | null } } = {},
): Promise<void> {
  await q
    .updateTable('purchase_orders')
    .set({
      status,
      ...(extra.approvedBy !== undefined && { approved_by: extra.approvedBy }),
      ...(extra.closed && { closed_by: extra.closed.by, closed_reason: extra.closed.reason, closed_at: sql<Date>`now()` }),
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .execute();
}

// ── Receiving ─────────────────────────────────────────────────────────────────

/** A line, locked until the transaction ends. */
export async function lockLine(
  q: Queryable,
  lineId: number,
): Promise<{ poId: string; bookId: number; quantity: number; receivedQuantity: number; unitCost: Money } | undefined> {
  const row = await q
    .selectFrom('po_line_items')
    .select(['po_id', 'book_id', 'quantity', 'received_quantity', 'unit_cost'])
    .where('id', '=', String(lineId))
    .forUpdate()
    .executeTakeFirst();
  return (
    row && {
      poId: String(row.po_id),
      bookId: row.book_id,
      quantity: row.quantity,
      receivedQuantity: row.received_quantity,
      unitCost: Money.of(row.unit_cost),
    }
  );
}

export async function addReceived(q: Queryable, lineId: number, quantity: number): Promise<void> {
  await q
    .updateTable('po_line_items')
    .set((eb) => ({ received_quantity: eb('received_quantity', '+', quantity) }))
    .where('id', '=', String(lineId))
    .execute();
}

export async function insertReceipt(
  q: Queryable,
  r: { poId: string; locationId: number; receivedBy: number; notes: string | null; items: Array<{ poLineItemId: number; quantityReceived: number }> },
): Promise<string> {
  const row = await q
    .insertInto('po_receipts')
    .values({ po_id: r.poId, location_id: r.locationId, received_by: r.receivedBy, notes: r.notes })
    .returning('id')
    .executeTakeFirstOrThrow();
  await q
    .insertInto('po_receipt_items')
    .values(r.items.map((i) => ({ receipt_id: row.id, po_line_item_id: String(i.poLineItemId), quantity_received: i.quantityReceived })))
    .execute();
  return String(row.id);
}

export async function lineQuantities(q: Queryable, poId: string): Promise<Array<{ quantity: number; receivedQuantity: number }>> {
  const rows = await q.selectFrom('po_line_items').select(['quantity', 'received_quantity']).where('po_id', '=', poId).execute();
  return rows.map((r) => ({ quantity: r.quantity, receivedQuantity: r.received_quantity }));
}

// ── Supplier payments ─────────────────────────────────────────────────────────

export async function insertSupplierPayment(
  q: Queryable,
  p: {
    poId: string;
    branchId: number;
    supplierId: number;
    amount: Money;
    paymentMethod: string;
    source: 'manual' | 'auto_on_receipt';
    notes: string | null;
    createdBy: number;
  },
): Promise<void> {
  await q
    .insertInto('supplier_payments')
    .values({
      po_id: p.poId,
      branch_id: p.branchId,
      supplier_id: p.supplierId,
      amount: p.amount.toFixed(2),
      payment_method: p.paymentMethod,
      source: p.source,
      notes: p.notes,
      created_by: p.createdBy,
    })
    .execute();
}

/** What the order's received goods are worth, and what was paid and credited against them. */
export async function settlement(q: Queryable, poId: string): Promise<{ received: Money; settled: Money }> {
  const { rows } = await sql<{ received: string; settled: string }>`
    SELECT
      COALESCE((SELECT SUM(received_quantity * unit_cost) FROM po_line_items WHERE po_id = ${poId}), 0) AS received,
      COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE po_id = ${poId}), 0)
        + COALESCE((SELECT SUM(amount) FROM supplier_credit_notes WHERE po_id = ${poId}), 0) AS settled`.execute(q);
  return { received: Money.of(rows[0].received), settled: Money.of(rows[0].settled) };
}

export async function setFinancialStatus(q: Queryable, poId: string, status: FinancialStatus): Promise<void> {
  await q.updateTable('purchase_orders').set({ financial_status: status, updated_at: sql`now()` }).where('id', '=', poId).execute();
}
