import pg from 'pg';
import { db } from '../../db/index.js';
import { BusinessError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { getEffectiveConfig } from '../config/config.service.js';

export interface StaffCtx { staffId: number; role: string; branchId: number; }
export interface OrderLineInput { bookId: number; quantity: number; discountAmount?: number; }

export interface OrderRow {
  id: string; orderNumber: string; customerId: number | null; branchId: number;
  locationId: number | null; channel: string; status: string; paymentStatus: string;
  currency: string; subtotal: number; discountAmount: number; taxRate: number;
  taxAmount: number; total: number; cancelReason: string | null; notes: string | null;
  createdBy: number; createdAt: string; updatedAt: string; lineItems?: OrderLineItemRow[];
}

export interface OrderLineItemRow {
  id: string; orderId: string; bookId: number; bookTitle: string; bookIsbn: string;
  quantity: number; unitPrice: number; discountAmount: number; totalPrice: number;
  qtyReserved: number; qtyFulfilled: number; isBackordered: boolean;
}

function mapOrderRow(row: Record<string, unknown>): OrderRow {
  return {
    id: String(row.id), orderNumber: row.order_number as string,
    customerId: (row.customer_id as number | null) ?? null, branchId: row.branch_id as number,
    locationId: (row.location_id as number | null) ?? null, channel: row.channel as string,
    status: row.status as string, paymentStatus: row.payment_status as string,
    currency: row.currency as string, subtotal: parseFloat(row.subtotal as string),
    discountAmount: parseFloat(row.discount_amount as string), taxRate: parseFloat(row.tax_rate as string),
    taxAmount: parseFloat(row.tax_amount as string), total: parseFloat(row.total as string),
    cancelReason: (row.cancel_reason as string | null) ?? null, notes: (row.notes as string | null) ?? null,
    createdBy: row.created_by as number,
    createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function mapLineItemRow(row: Record<string, unknown>): OrderLineItemRow {
  return {
    id: String(row.id), orderId: String(row.order_id), bookId: row.book_id as number,
    bookTitle: (row.book_title as string) ?? '', bookIsbn: (row.book_isbn as string) ?? '',
    quantity: row.quantity as number, unitPrice: parseFloat(row.unit_price as string),
    discountAmount: parseFloat(row.discount_amount as string), totalPrice: parseFloat(row.total_price as string),
    qtyReserved: row.qty_reserved as number, qtyFulfilled: row.qty_fulfilled as number,
    isBackordered: row.is_backordered as boolean,
  };
}

async function fetchLineItems(orderId: string): Promise<OrderLineItemRow[]> {
  const res = await db.query(
    'SELECT oli.*, b.title AS book_title, b.isbn AS book_isbn FROM order_line_items oli JOIN books b ON b.id = oli.book_id WHERE oli.order_id = $1 ORDER BY oli.id',
    [orderId],
  );
  return res.rows.map(mapLineItemRow);
}

export async function getById(id: string | number): Promise<OrderRow> {
  const res = await db.query('SELECT o.* FROM orders o WHERE o.id = $1', [id]);
  if (!res.rows.length) throw new NotFoundError('Order');
  const order = mapOrderRow(res.rows[0]);
  order.lineItems = await fetchLineItems(order.id);
  return order;
}

export async function list(opts: {
  branchId?: number; customerId?: number; status?: string; paymentStatus?: string;
  channel?: string; dateFrom?: string; dateTo?: string; page?: number; pageSize?: number;
}): Promise<{ items: OrderRow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset = (page - 1) * pageSize;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.branchId)      { params.push(opts.branchId);      conditions.push('o.branch_id = $' + params.length); }
  if (opts.customerId)    { params.push(opts.customerId);    conditions.push('o.customer_id = $' + params.length); }
  if (opts.status)        { params.push(opts.status);        conditions.push('o.status = $' + params.length); }
  if (opts.paymentStatus) { params.push(opts.paymentStatus); conditions.push('o.payment_status = $' + params.length); }
  if (opts.channel)       { params.push(opts.channel);       conditions.push('o.channel = $' + params.length); }
  if (opts.dateFrom)      { params.push(opts.dateFrom);      conditions.push('o.created_at >= $' + params.length); }
  if (opts.dateTo)        { params.push(opts.dateTo);        conditions.push('o.created_at <= $' + params.length); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const li = params.length + 1; const oi = params.length + 2;
  const [countRes, dataRes] = await Promise.all([
    db.query('SELECT COUNT(*) FROM orders o ' + where, params),
    db.query('SELECT o.* FROM orders o ' + where + ' ORDER BY o.created_at DESC LIMIT $' + li + ' OFFSET $' + oi, [...params, pageSize, offset]),
  ]);
  return { items: dataRes.rows.map(mapOrderRow), total: parseInt(countRes.rows[0].count, 10), page, totalPages: Math.ceil(parseInt(countRes.rows[0].count, 10) / pageSize) };
}

export async function create(
  data: { customerId?: number | null; locationId?: number | null; channel?: string; notes?: string; items: OrderLineInput[]; },
  staffCtx: StaffCtx,
): Promise<OrderRow> {
  if (!data.items || data.items.length === 0) throw new ValidationError('At least one item is required');
  interface RI { bookId: number; quantity: number; unitPrice: number; discountAmount: number; totalPrice: number; }
  const resolvedItems: RI[] = [];

  // F-008: Deactivated branch check
  const branchCheck = await db.query('SELECT is_active FROM branches WHERE id = $1', [staffCtx.branchId]);
  if (!branchCheck.rows.length || !branchCheck.rows[0].is_active) {
    throw new BusinessError('BRANCH_INACTIVE', 'This branch is inactive and cannot accept new orders');
  }

  // F-009: Deactivated customer check
  if (data.customerId) {
    const custCheck = await db.query('SELECT is_active FROM customers WHERE id = $1', [data.customerId]);
    if (!custCheck.rows.length || !custCheck.rows[0].is_active) {
      throw new BusinessError('CUSTOMER_INACTIVE', 'This customer account is inactive');
    }
  }
  for (const item of data.items) {
    const bookRes = await db.query('SELECT id, title, is_active FROM books WHERE id = $1', [item.bookId]);
    if (!bookRes.rows.length) throw new NotFoundError('Book ' + item.bookId);
    const book = bookRes.rows[0];
    if (!book.is_active) throw new BusinessError('BOOK_INACTIVE', 'Book ' + item.bookId + ' is not active');
    const priceRes = await db.query('SELECT COALESCE(bbp.price, b.default_price) AS price FROM books b LEFT JOIN book_branch_prices bbp ON bbp.book_id = b.id AND bbp.branch_id = $2 AND bbp.format_id = 0 AND bbp.edition_id = 0 WHERE b.id = $1', [item.bookId, staffCtx.branchId]);
    const unitPrice = priceRes.rows[0]?.price != null ? parseFloat(priceRes.rows[0].price) : null;
    if (unitPrice === null) throw new BusinessError('PRICE_NOT_SET', 'Price not set for book ' + item.bookId);
    const discountAmount = parseFloat((item.discountAmount ?? 0).toFixed(2));
    const totalPrice = parseFloat((unitPrice * item.quantity - discountAmount).toFixed(2));
    resolvedItems.push({ bookId: item.bookId, quantity: item.quantity, unitPrice, discountAmount, totalPrice });
  }
  const subtotal = parseFloat(resolvedItems.reduce((s, i) => s + i.totalPrice, 0).toFixed(2));
  const discountTotal = parseFloat(resolvedItems.reduce((s, i) => s + i.discountAmount, 0).toFixed(2));
  let taxRate = 0.10;
  try { taxRate = Number(await getEffectiveConfig(staffCtx.branchId, 'tax_rate')); } catch {}
  const taxAmount = parseFloat((subtotal * taxRate).toFixed(2));
  const total = parseFloat((subtotal + taxAmount).toFixed(2));
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cntRes = await client.query('SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURRENT_DATE');
    const orderNumber = 'ORD-' + dateStr + '-' + String(parseInt(cntRes.rows[0].count, 10) + 1).padStart(4, '0');
    const orderRes = await client.query(
      'INSERT INTO orders (order_number, customer_id, branch_id, location_id, channel, status, payment_status, currency, subtotal, discount_amount, tax_rate, tax_amount, total, notes, created_by) VALUES ($1,$2,$3,$4,$5,\'Pending\',\'unpaid\',\'ETB\',$6,$7,$8,$9,$10,$11,$12) RETURNING id',
      [orderNumber, data.customerId ?? null, staffCtx.branchId, data.locationId ?? null, data.channel ?? 'in_store', subtotal.toFixed(2), discountTotal.toFixed(2), taxRate.toFixed(4), taxAmount.toFixed(2), total.toFixed(2), data.notes ?? null, staffCtx.staffId],
    );
    const orderId = String(orderRes.rows[0].id);
    for (const item of resolvedItems) {
      await client.query('INSERT INTO order_line_items (order_id, book_id, quantity, unit_price, discount_amount, total_price) VALUES ($1,$2,$3,$4,$5,$6)', [orderId, item.bookId, item.quantity, item.unitPrice.toFixed(2), item.discountAmount.toFixed(2), item.totalPrice.toFixed(2)]);
    }
    await client.query('INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,\'CREATE\',\'order\',$3,$4,$5)', [staffCtx.staffId, staffCtx.role, orderId, staffCtx.branchId, JSON.stringify({ orderNumber, total, itemCount: resolvedItems.length })]);
    await client.query('COMMIT');
    return getById(orderId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

async function resolveLocationId(client: pg.PoolClient, order: OrderRow, staffCtx: StaffCtx): Promise<number> {
  if (order.locationId) return order.locationId;
  // Try branch default fulfillment location
  const defRes = await client.query(
    'SELECT id FROM locations WHERE branch_id = $1 AND is_default_fulfillment = true LIMIT 1',
    [order.branchId],
  );
  if (defRes.rows.length) return defRes.rows[0].id as number;
  // Fall back to any location in the branch
  const anyRes = await client.query(
    'SELECT id FROM locations WHERE branch_id = $1 ORDER BY id LIMIT 1',
    [order.branchId],
  );
  if (anyRes.rows.length) return anyRes.rows[0].id as number;
  // Last resort: use branchId (legacy behaviour)
  return staffCtx.branchId;
}

export async function confirm(orderId: string | number, staffCtx: StaffCtx): Promise<OrderRow> {
  const order = await getById(orderId);
  if (order.status !== 'Pending') throw new BusinessError('INVALID_STATE', "Cannot confirm order in status '" + order.status + "'");
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locationId = await resolveLocationId(client, order, staffCtx);
    for (const item of order.lineItems ?? []) {
      const invRes = await client.query('SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE', [item.bookId, locationId]);
      if (!invRes.rows.length || invRes.rows[0].quantity < item.quantity) {
        await client.query('UPDATE order_line_items SET is_backordered = true WHERE id = $1', [item.id]);
      } else {
        await client.query('UPDATE order_line_items SET qty_reserved = $1 WHERE id = $2', [item.quantity, item.id]);
      }
    }
    await client.query("UPDATE orders SET status = 'Confirmed', updated_at = now() WHERE id = $1", [orderId]);
    await client.query('INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,\'UPDATE\',\'order\',$3,$4,$5)', [staffCtx.staffId, staffCtx.role, String(orderId), staffCtx.branchId, JSON.stringify({ action: 'confirm' })]);
    await client.query('COMMIT');
    return getById(orderId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

export async function progress(orderId: string | number, staffCtx: StaffCtx): Promise<OrderRow> {
  const order = await getById(orderId);
  if (order.status !== 'Confirmed') throw new BusinessError('INVALID_STATE', "Cannot progress order in status '" + order.status + "'");
  await db.query("UPDATE orders SET status = 'In_Progress', updated_at = now() WHERE id = $1", [orderId]);
  await db.query('INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,\'UPDATE\',\'order\',$3,$4,$5)', [staffCtx.staffId, staffCtx.role, String(orderId), staffCtx.branchId, JSON.stringify({ action: 'progress' })]);
  return getById(orderId);
}

export async function fulfill(orderId: string | number, staffCtx: StaffCtx): Promise<OrderRow> {
  const order = await getById(orderId);
  if (!['Confirmed', 'In_Progress'].includes(order.status)) throw new BusinessError('INVALID_STATE', "Cannot fulfill order in status '" + order.status + "'");
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const locationId = await resolveLocationId(client, order, staffCtx);
    for (const item of order.lineItems ?? []) {
      if (item.qtyReserved === 0) continue;
      const invRes = await client.query('SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE', [item.bookId, locationId]);
      if (!invRes.rows.length) throw new NotFoundError('Inventory for book ' + item.bookId);
      const qtyBefore = invRes.rows[0].quantity;
      const ver = invRes.rows[0].version;
      const qtyAfter = qtyBefore - item.qtyReserved;
      const updated = await client.query('UPDATE inventory SET quantity = $1, version = version + 1, updated_at = now() WHERE book_id = $2 AND location_id = $3 AND version = $4 RETURNING book_id', [qtyAfter, item.bookId, locationId, ver]);
      if (!updated.rows.length) throw new ConflictError('VERSION_CONFLICT', 'Inventory modified concurrently. Please retry.');
      await client.query("INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, reference_type, reference_id, notes, staff_id) VALUES ($1,$2,$3,$4,$5,'stock_out','stock_out','order',$6,'Order fulfillment',$7)", [item.bookId, locationId, qtyBefore, qtyAfter, -item.qtyReserved, orderId, staffCtx.staffId]);
      await client.query('UPDATE order_line_items SET qty_fulfilled = qty_fulfilled + $1, qty_reserved = 0 WHERE id = $2', [item.qtyReserved, item.id]);
    }
    await client.query("UPDATE orders SET status = 'Fulfilled', updated_at = now() WHERE id = $1", [orderId]);
    await client.query('INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,\'UPDATE\',\'order\',$3,$4,$5)', [staffCtx.staffId, staffCtx.role, String(orderId), staffCtx.branchId, JSON.stringify({ action: 'fulfill' })]);
    await client.query('COMMIT');
    return getById(orderId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

export async function cancel(orderId: string | number, reason: string, staffCtx: StaffCtx): Promise<OrderRow> {
  const order = await getById(orderId);
  if (order.status === 'Fulfilled') throw new BusinessError('ORDER_ALREADY_FULFILLED', 'Cannot cancel a fulfilled order');
  if (order.status === 'Cancelled') throw new BusinessError('ALREADY_CANCELLED', 'Order is already cancelled');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const item of order.lineItems ?? []) {
      if (item.qtyReserved > 0) {
        await client.query('UPDATE order_line_items SET qty_reserved = 0 WHERE id = $1', [item.id]);
      }
    }
    await client.query("UPDATE orders SET status = 'Cancelled', cancel_reason = $1, updated_at = now() WHERE id = $2", [reason, orderId]);
    await client.query('INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,\'UPDATE\',\'order\',$3,$4,$5)', [staffCtx.staffId, staffCtx.role, String(orderId), staffCtx.branchId, JSON.stringify({ action: 'cancel', reason })]);
    await client.query('COMMIT');
    return getById(orderId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

export async function updatePaymentStatus(orderId: string | number, paymentStatus: 'unpaid' | 'partial' | 'paid' | 'refunded'): Promise<void> {
  await db.query('UPDATE orders SET payment_status = $1, updated_at = now() WHERE id = $2', [paymentStatus, orderId]);
}
