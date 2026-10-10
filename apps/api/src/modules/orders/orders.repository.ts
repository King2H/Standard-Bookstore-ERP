import { sql } from 'kysely';
import type { Queryable } from '../../db/tx.js';
import { toLineItemRow, toOrderRow, type OrderDbRow } from './orders.mapper.js';
import type { OrderLineItemRow, OrderPaymentStatus, OrderRow, OrderTotals, PricedLine, SaleType } from './orders.types.js';

// All SQL of the Orders module (A6). A few statements touch tables owned by
// Inventory (inventory, inventory_reservations) and Customers (store credit);
// they move to those modules' repositories when the modules migrate (M5, #21).

const ORDER_COLUMNS = [
  'o.id', 'o.order_number', 'o.customer_id', 'o.branch_id', 'o.location_id', 'o.channel', 'o.status',
  'o.payment_status', 'o.sale_type', 'o.currency', 'o.subtotal', 'o.discount_amount', 'o.discount_total',
  'o.tax_rate', 'o.tax_amount', 'o.total', 'o.cancel_reason', 'o.notes', 'o.created_by', 'o.created_at',
  'o.updated_at',
] as const;

/** The order with the method of its first payment and its receivable's due date. */
export async function findById(q: Queryable, id: string | number, opts: { forUpdate?: boolean } = {}): Promise<OrderRow | undefined> {
  let query = q
    .selectFrom('orders as o')
    .select(ORDER_COLUMNS)
    .select([
      sql<string | null>`(SELECT op.payment_method FROM order_payments op WHERE op.order_id = o.id ORDER BY op.created_at ASC LIMIT 1)`.as('payment_method'),
      sql<string | null>`(SELECT TO_CHAR(r.due_date, 'YYYY-MM-DD') FROM receivables r WHERE r.source_type = 'order_credit_sale' AND r.source_entity_id = o.id LIMIT 1)`.as('due_date'),
    ])
    .where('o.id', '=', String(id));
  if (opts.forUpdate) query = query.forUpdate('o');
  const row = await query.executeTakeFirst();
  return row && toOrderRow(row as OrderDbRow);
}

export async function listLineItems(q: Queryable, orderId: string): Promise<OrderLineItemRow[]> {
  const rows = await q
    .selectFrom('order_line_items as oli')
    .innerJoin('books as b', 'b.id', 'oli.book_id')
    .select([
      'oli.id', 'oli.order_id', 'oli.book_id', 'b.title as book_title', 'b.isbn as book_isbn', 'oli.quantity',
      'oli.unit_price', 'oli.discount_amount', 'oli.total_price', 'oli.qty_reserved', 'oli.qty_fulfilled',
      'oli.is_backordered', 'oli.unit_cost',
    ])
    .where('oli.order_id', '=', orderId)
    .orderBy('oli.id')
    .execute();
  return rows.map(toLineItemRow);
}

export interface OrderFilter {
  branchId?: number;
  customerId?: number;
  statuses?: string[];
  paymentStatus?: string;
  channel?: string;
  dateFrom?: string;
  dateTo?: string;
}

export async function list(
  q: Queryable,
  filter: OrderFilter,
  page: { limit: number; offset: number },
): Promise<{ items: OrderRow[]; total: number }> {
  let query = q.selectFrom('orders as o');
  if (filter.branchId) query = query.where('o.branch_id', '=', filter.branchId);
  if (filter.customerId) query = query.where('o.customer_id', '=', filter.customerId);
  if (filter.statuses?.length) query = query.where('o.status', 'in', filter.statuses);
  if (filter.paymentStatus) query = query.where('o.payment_status', '=', filter.paymentStatus);
  if (filter.channel) query = query.where('o.channel', '=', filter.channel);
  if (filter.dateFrom) query = query.where('o.created_at', '>=', sql<Date>`${filter.dateFrom}`);
  if (filter.dateTo) query = query.where('o.created_at', '<=', sql<Date>`${filter.dateTo}`);

  const [rows, count] = await Promise.all([
    query.select(ORDER_COLUMNS).orderBy('o.created_at', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map((r) => toOrderRow(r as OrderDbRow)), total: Number(count.total) };
}

// ── Lookups for a new order ──────────────────────────────────────────────────

export async function isBranchActive(q: Queryable, branchId: number): Promise<boolean> {
  const row = await q.selectFrom('branches').select('is_active').where('id', '=', branchId).executeTakeFirst();
  return row?.is_active === true;
}

export async function isCustomerActive(q: Queryable, customerId: number): Promise<boolean> {
  const row = await q.selectFrom('customers').select('is_active').where('id', '=', customerId).executeTakeFirst();
  return row?.is_active === true;
}

export async function findBook(q: Queryable, bookId: number): Promise<{ title: string; isActive: boolean } | undefined> {
  const row = await q.selectFrom('books').select(['title', 'is_active']).where('id', '=', bookId).executeTakeFirst();
  return row && { title: row.title, isActive: row.is_active };
}

/** The branch's base price for the book, or its default price; null when neither is set. */
export async function findSellingPrice(q: Queryable, bookId: number, branchId: number): Promise<number | null> {
  const row = await q
    .selectFrom('books as b')
    .leftJoin('book_branch_prices as bbp', (join) =>
      join
        .onRef('bbp.book_id', '=', 'b.id')
        .on('bbp.branch_id', '=', branchId)
        .on('bbp.format_id', '=', 0)
        .on('bbp.edition_id', '=', 0),
    )
    .select(sql<string | null>`COALESCE(bbp.price, b.default_price)`.as('price'))
    .where('b.id', '=', bookId)
    .executeTakeFirst();
  return row?.price != null ? Number(row.price) : null;
}

export async function findLocationName(q: Queryable, locationId: number): Promise<string | undefined> {
  const row = await q.selectFrom('locations').select('name').where('id', '=', locationId).executeTakeFirst();
  return row?.name;
}

/** The branch's default fulfilment location, else its first location. */
export async function findBranchLocation(q: Queryable, branchId: number): Promise<number | undefined> {
  const preferred = await q
    .selectFrom('locations')
    .select('id')
    .where('branch_id', '=', branchId)
    .where('is_default_fulfillment', '=', true)
    .limit(1)
    .executeTakeFirst();
  if (preferred) return preferred.id;
  const any = await q.selectFrom('locations').select('id').where('branch_id', '=', branchId).orderBy('id').limit(1).executeTakeFirst();
  return any?.id;
}

/** Today's date (the database's, YYYY-MM-DD and YYYYMMDD) and how many rows of `table` were created today. */
export async function countCreatedToday(
  q: Queryable,
  table: 'orders' | 'order_payments',
): Promise<{ count: number; dateStr: string }> {
  const { rows } = await sql<{ count: string; date_str: string }>`
    SELECT COUNT(*) AS count, TO_CHAR(CURRENT_DATE, 'YYYYMMDD') AS date_str
    FROM ${sql.table(table)} WHERE DATE(created_at) = CURRENT_DATE`.execute(q);
  return { count: Number(rows[0].count), dateStr: rows[0].date_str };
}

export async function today(q: Queryable): Promise<string> {
  const { rows } = await sql<{ today: string }>`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today`.execute(q);
  return rows[0].today;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function insertOrder(
  q: Queryable,
  order: {
    orderNumber: string; customerId: number | null; branchId: number; locationId: number | null;
    channel: string; saleType: SaleType; notes: string | null; createdBy: number; totals: OrderTotals;
  },
): Promise<string> {
  const row = await q
    .insertInto('orders')
    .values({
      order_number: order.orderNumber,
      customer_id: order.customerId,
      branch_id: order.branchId,
      location_id: order.locationId,
      channel: order.channel,
      status: 'DRAFT',
      payment_status: 'unpaid',
      currency: 'ETB',
      subtotal: order.totals.subtotal,
      discount_amount: order.totals.discountTotal,
      discount_total: order.totals.discountTotal,
      tax_rate: order.totals.taxRate,
      tax_amount: order.totals.taxAmount,
      total: order.totals.total,
      sale_type: order.saleType,
      notes: order.notes,
      created_by: order.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return String(row.id);
}

export async function insertLineItem(q: Queryable, orderId: string, line: PricedLine): Promise<void> {
  await q
    .insertInto('order_line_items')
    .values({
      order_id: orderId,
      book_id: line.bookId,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      discount_amount: line.discountAmount,
      total_price: line.totalPrice,
      discount_pct: line.discountPct.toFixed(4),
      discount_type: line.discountType,
      discount_mode: line.discountMode,
    })
    .execute();
}

export async function setStatus(q: Queryable, orderId: string, status: string, cancelReason?: string): Promise<void> {
  await q
    .updateTable('orders')
    .set({ status, ...(cancelReason !== undefined ? { cancel_reason: cancelReason } : {}), updated_at: sql`now()` })
    .where('id', '=', orderId)
    .execute();
}

export async function setPaymentStatus(q: Queryable, orderId: string, paymentStatus: OrderPaymentStatus): Promise<void> {
  await q.updateTable('orders').set({ payment_status: paymentStatus, updated_at: sql`now()` }).where('id', '=', orderId).execute();
}

export async function setLineReserved(q: Queryable, lineId: string, quantity: number): Promise<void> {
  await q.updateTable('order_line_items').set({ qty_reserved: quantity }).where('id', '=', lineId).execute();
}

export async function setLineUnitCost(q: Queryable, lineId: string, unitCost: string): Promise<void> {
  await q.updateTable('order_line_items').set({ unit_cost: unitCost }).where('id', '=', lineId).execute();
}

/** Moves a line's reserved quantity to fulfilled. */
export async function fulfillLine(q: Queryable, lineId: string, quantity: number): Promise<void> {
  await q
    .updateTable('order_line_items')
    .set((eb) => ({ qty_fulfilled: eb('qty_fulfilled', '+', quantity), qty_reserved: 0 }))
    .where('id', '=', lineId)
    .execute();
}

export async function deleteOrder(q: Queryable, orderId: string): Promise<void> {
  await q.deleteFrom('orders').where('id', '=', orderId).execute();
}

// ── Inventory (moves to the Inventory repository in M5) ──────────────────────

/** Locks the stock row of a book at a location until the transaction ends. */
export async function lockStock(q: Queryable, bookId: number, locationId: number): Promise<void> {
  await q.selectFrom('inventory').select('quantity').where('book_id', '=', bookId).where('location_id', '=', locationId).forUpdate().execute();
}

export async function insertReservation(
  q: Queryable,
  r: { orderId: string; bookId: number; locationId: number; quantity: number },
): Promise<void> {
  await q
    .insertInto('inventory_reservations')
    .values({ order_id: r.orderId, book_id: r.bookId, location_id: r.locationId, quantity: r.quantity, status: 'reserved' })
    .execute();
}

export async function releaseReservations(q: Queryable, orderId: string): Promise<void> {
  await q
    .updateTable('inventory_reservations')
    .set({ status: 'released', updated_at: sql`now()` })
    .where('order_id', '=', orderId)
    .where('status', '=', 'reserved')
    .execute();
}

// ── Store credit (moves to the Customers repository in M5) ──────────────────

export async function lockStoreCreditBalance(q: Queryable, customerId: number): Promise<string | null> {
  const row = await q.selectFrom('store_credit_accounts').select('balance').where('customer_id', '=', customerId).forUpdate().executeTakeFirst();
  return row?.balance ?? null;
}

export async function debitStoreCredit(q: Queryable, customerId: number, amount: string, orderId: string): Promise<void> {
  await q
    .updateTable('store_credit_accounts')
    .set((eb) => ({ balance: eb('balance', '-', amount) }))
    .where('customer_id', '=', customerId)
    .execute();
  await q
    .insertInto('store_credit_history')
    .values({ customer_id: customerId, ref_type: 'order_cash_sale', ref_id: orderId, amount, direction: 'debit' })
    .execute();
}

// ── Payments and receivables ─────────────────────────────────────────────────

export async function insertPayment(
  q: Queryable,
  p: { reference: string; orderId: string; amount: string; method: string; notes: string; processedBy: number },
): Promise<void> {
  await q
    .insertInto('order_payments')
    .values({
      payment_reference: p.reference,
      order_id: p.orderId,
      amount: p.amount,
      currency: 'ETB',
      payment_method: p.method,
      status: 'success',
      notes: p.notes,
      processed_by: p.processedBy,
    })
    .execute();
}

/** What was paid on the order, refunded payments included (they were received). */
/** What the order has been paid, less what was refunded. */
export async function sumPaid(q: Queryable, orderId: string): Promise<string> {
  const row = await q
    .selectFrom('order_payments')
    .select(sql<string>`COALESCE(SUM(amount), 0) - (SELECT COALESCE(SUM(refund_amount), 0) FROM order_refunds WHERE order_id = ${orderId})`.as('total_paid'))
    .where('order_id', '=', orderId)
    .where('status', 'in', ['success', 'partially_refunded', 'refunded'])
    .executeTakeFirstOrThrow();
  return row.total_paid;
}

export async function hasReceivable(q: Queryable, orderId: string, opts: { openOnly?: boolean } = {}): Promise<boolean> {
  let query = q
    .selectFrom('receivables')
    .select(sql`1`.as('one'))
    .where('source_type', '=', 'order_credit_sale')
    .where('source_entity_id', '=', orderId);
  if (opts.openOnly) query = query.where('status', 'in', ['Pending', 'PartiallyPaid', 'Overdue']);
  return (await query.limit(1).executeTakeFirst()) !== undefined;
}

export async function lockReceivableOutstanding(q: Queryable, orderId: string): Promise<string | undefined> {
  const row = await q
    .selectFrom('receivables')
    .select('outstanding_amount')
    .where('source_type', '=', 'order_credit_sale')
    .where('source_entity_id', '=', orderId)
    .forUpdate()
    .executeTakeFirst();
  return row?.outstanding_amount;
}

/** Records that keep an order from being deleted, as readable names. */
export async function deleteBlockers(q: Queryable, orderId: string): Promise<string[]> {
  const exists = async (query: { executeTakeFirst(): Promise<unknown> }) => (await query.executeTakeFirst()) !== undefined;
  const one = sql`1`.as('one');
  const [payments, receivable, plan, exchange, history] = await Promise.all([
    exists(q.selectFrom('order_payments').select(one).where('order_id', '=', orderId).limit(1)),
    hasReceivable(q, orderId),
    exists(q.selectFrom('installment_plans').select(one).where('order_id', '=', orderId).limit(1)),
    exists(q.selectFrom('exchanges').select(one).where('original_order_id', '=', orderId).limit(1)),
    exists(
      q.selectFrom('inventory_history')
        .select(one)
        .where('reference_type', 'in', ['order_confirmed', 'order_cancelled'])
        .where('reference_id', '=', orderId)
        .limit(1),
    ),
  ]);
  return [
    payments && 'payments',
    receivable && 'a receivable',
    plan && 'an installment plan',
    exchange && 'a linked exchange',
    history && 'inventory movement history',
  ].filter((b): b is string => typeof b === 'string');
}
