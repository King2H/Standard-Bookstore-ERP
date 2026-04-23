import { db } from '../../db/index.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { insertOutbox } from '../../lib/outbox.js';

export interface StaffCtx { staffId: number; role: string; branchId: number; }

export interface ExchangeItemInput {
  bookId: number;
  quantity: number;
  unitPrice: number;
}

export interface ExchangeRow {
  id: string;
  exchangeReference: string;
  branchId: number;
  locationId: number | null;
  customerId: number | null;
  status: string;
  totalIncomingValue: number;
  totalOutgoingValue: number;
  netBalance: number;
  settlementType: string;
  currency: string;
  notes: string | null;
  relatedPaymentId: string | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  incomingItems?: ExchangeItemRow[];
  outgoingItems?: ExchangeItemRow[];
}

export interface ExchangeItemRow {
  id: string;
  exchangeId: string;
  bookId: number;
  bookTitle: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

function mapExchangeRow(row: Record<string, unknown>): ExchangeRow {
  return {
    id: String(row.id),
    exchangeReference: row.exchange_reference as string,
    branchId: row.branch_id as number,
    locationId: (row.location_id as number | null) ?? null,
    customerId: (row.customer_id as number | null) ?? null,
    status: row.status as string,
    totalIncomingValue: parseFloat(row.total_incoming_value as string),
    totalOutgoingValue: parseFloat(row.total_outgoing_value as string),
    netBalance: parseFloat(row.net_balance as string),
    settlementType: row.settlement_type as string,
    currency: row.currency as string,
    notes: (row.notes as string | null) ?? null,
    relatedPaymentId: row.related_payment_id != null ? String(row.related_payment_id) : null,
    createdBy: row.created_by as number,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function mapItemRow(row: Record<string, unknown>, priceField: string): ExchangeItemRow {
  return {
    id: String(row.id),
    exchangeId: String(row.exchange_id),
    bookId: row.book_id as number,
    bookTitle: (row.book_title as string) ?? '',
    quantity: row.quantity as number,
    unitPrice: parseFloat(row[priceField] as string),
    totalPrice: parseFloat(row.total_price as string),
  };
}

async function fetchItems(exchangeId: string): Promise<{ incoming: ExchangeItemRow[]; outgoing: ExchangeItemRow[] }> {
  const [inRes, outRes] = await Promise.all([
    db.query('SELECT ei.*, b.title AS book_title FROM exchange_incoming_items ei JOIN books b ON b.id = ei.book_id WHERE ei.exchange_id = $1 ORDER BY ei.id', [exchangeId]),
    db.query('SELECT eo.*, b.title AS book_title FROM exchange_outgoing_items eo JOIN books b ON b.id = eo.book_id WHERE eo.exchange_id = $1 ORDER BY eo.id', [exchangeId]),
  ]);
  return {
    incoming: inRes.rows.map(r => mapItemRow(r, 'evaluated_unit_price')),
    outgoing: outRes.rows.map(r => mapItemRow(r, 'selling_unit_price')),
  };
}

export async function getById(id: string | number): Promise<ExchangeRow> {
  const res = await db.query('SELECT * FROM exchanges WHERE id = $1', [id]);
  if (!res.rows.length) throw new NotFoundError('Exchange');
  const exchange = mapExchangeRow(res.rows[0]);
  const items = await fetchItems(exchange.id);
  exchange.incomingItems = items.incoming;
  exchange.outgoingItems = items.outgoing;
  return exchange;
}

export async function list(opts: {
  branchId?: number;
  customerId?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ items: ExchangeRow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset = (page - 1) * pageSize;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.branchId)   { params.push(opts.branchId);   conditions.push('e.branch_id = $' + params.length); }
  if (opts.customerId) { params.push(opts.customerId); conditions.push('e.customer_id = $' + params.length); }
  if (opts.status)     { params.push(opts.status);     conditions.push('e.status = $' + params.length); }
  if (opts.dateFrom)   { params.push(opts.dateFrom);   conditions.push('e.created_at >= $' + params.length); }
  if (opts.dateTo)     { params.push(opts.dateTo);     conditions.push('e.created_at <= $' + params.length); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const li = params.length + 1;
  const oi = params.length + 2;

  const [countRes, dataRes] = await Promise.all([
    db.query('SELECT COUNT(*) FROM exchanges e ' + where, params),
    db.query('SELECT e.* FROM exchanges e ' + where + ' ORDER BY e.created_at DESC LIMIT $' + li + ' OFFSET $' + oi, [...params, pageSize, offset]),
  ]);

  return {
    items: dataRes.rows.map(mapExchangeRow),
    total: parseInt(countRes.rows[0].count as string, 10),
    page,
    totalPages: Math.ceil(parseInt(countRes.rows[0].count as string, 10) / pageSize),
  };
}

// ── createExchange ────────────────────────────────────────────────────────────
// Single-step atomic exchange: validates items, updates inventory, settles.

export async function createExchange(
  data: {
    locationId?: number | null;
    customerId?: number | null;
    notes?: string;
    incomingItems: ExchangeItemInput[];
    outgoingItems: ExchangeItemInput[];
  },
  staffCtx: StaffCtx,
): Promise<ExchangeRow> {
  if ((!data.incomingItems || data.incomingItems.length === 0) &&
      (!data.outgoingItems || data.outgoingItems.length === 0)) {
    throw new ValidationError('Exchange must have at least one incoming or outgoing item');
  }

  // Validate all books exist and are active
  const allBookIds = [
    ...(data.incomingItems ?? []).map(i => i.bookId),
    ...(data.outgoingItems ?? []).map(i => i.bookId),
  ];
  for (const bookId of allBookIds) {
    const bookRes = await db.query('SELECT id, is_active FROM books WHERE id = $1', [bookId]);
    if (!bookRes.rows.length) throw new NotFoundError('Book ' + bookId);
    if (!bookRes.rows[0].is_active) throw new BusinessError('BOOK_INACTIVE', 'Book ' + bookId + ' is not active');
  }

  // Validate outgoing items have sufficient stock
  const locationId = data.locationId ?? null;
  if (locationId && data.outgoingItems && data.outgoingItems.length > 0) {
    for (const item of data.outgoingItems) {
      const invRes = await db.query('SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2', [item.bookId, locationId]);
      const available = invRes.rows[0]?.quantity ?? 0;
      if (available < item.quantity) {
        throw new BusinessError('INSUFFICIENT_STOCK', 'Insufficient stock for book ' + item.bookId + '. Available: ' + available + ', requested: ' + item.quantity, { available, requested: item.quantity });
      }
    }
  }

  // Compute values
  const totalIncoming = parseFloat(
    (data.incomingItems ?? []).reduce((s, i) => s + i.unitPrice * i.quantity, 0).toFixed(2)
  );
  const totalOutgoing = parseFloat(
    (data.outgoingItems ?? []).reduce((s, i) => s + i.unitPrice * i.quantity, 0).toFixed(2)
  );
  const netBalance = parseFloat((totalOutgoing - totalIncoming).toFixed(2));

  let settlementType: 'Even' | 'Customer_Pays' | 'Store_Refunds';
  if (Math.abs(netBalance) < 0.01) settlementType = 'Even';
  else if (netBalance > 0) settlementType = 'Customer_Pays';
  else settlementType = 'Store_Refunds';

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Generate exchange reference
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cntRes = await client.query('SELECT COUNT(*) FROM exchanges WHERE DATE(created_at) = CURRENT_DATE');
    const exchangeReference = 'EXC-' + dateStr + '-' + String(parseInt(cntRes.rows[0].count as string, 10) + 1).padStart(4, '0');

    // INSERT exchange
    const excRes = await client.query(
      "INSERT INTO exchanges (exchange_reference, branch_id, location_id, customer_id, status, total_incoming_value, total_outgoing_value, net_balance, settlement_type, currency, notes, created_by) VALUES ($1,$2,$3,$4,'Evaluated',$5,$6,$7,$8,'ETB',$9,$10) RETURNING id",
      [exchangeReference, staffCtx.branchId, locationId, data.customerId ?? null,
       totalIncoming.toFixed(2), totalOutgoing.toFixed(2), netBalance.toFixed(2),
       settlementType, data.notes ?? null, staffCtx.staffId],
    );
    const exchangeId = String(excRes.rows[0].id);

    // INSERT incoming items
    for (const item of data.incomingItems ?? []) {
      const totalPrice = parseFloat((item.unitPrice * item.quantity).toFixed(2));
      await client.query('INSERT INTO exchange_incoming_items (exchange_id, book_id, quantity, evaluated_unit_price, total_price) VALUES ($1,$2,$3,$4,$5)', [exchangeId, item.bookId, item.quantity, item.unitPrice.toFixed(2), totalPrice.toFixed(2)]);
    }

    // INSERT outgoing items
    for (const item of data.outgoingItems ?? []) {
      const totalPrice = parseFloat((item.unitPrice * item.quantity).toFixed(2));
      await client.query('INSERT INTO exchange_outgoing_items (exchange_id, book_id, quantity, selling_unit_price, total_price) VALUES ($1,$2,$3,$4,$5)', [exchangeId, item.bookId, item.quantity, item.unitPrice.toFixed(2), totalPrice.toFixed(2)]);
    }

    // Update inventory — incoming items increase stock, outgoing decrease
    if (locationId) {
      for (const item of data.incomingItems ?? []) {
        await client.query('INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1,$2,0,5,0) ON CONFLICT (book_id, location_id) DO NOTHING', [item.bookId, locationId]);
        const invRes = await client.query('SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE', [item.bookId, locationId]);
        const qtyBefore = invRes.rows[0].quantity as number;
        const ver = invRes.rows[0].version as number;
        await client.query('UPDATE inventory SET quantity = quantity + $1, version = version + 1, updated_at = now() WHERE book_id = $2 AND location_id = $3', [item.quantity, item.bookId, locationId]);
        await client.query("INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, reference_type, reference_id, notes, staff_id) VALUES ($1,$2,$3,$4,$5,'stock_in','stock_in','exchange_in',$6,'Exchange incoming',$7)", [item.bookId, locationId, qtyBefore, qtyBefore + item.quantity, item.quantity, exchangeId, staffCtx.staffId]);
      }

      for (const item of data.outgoingItems ?? []) {
        const invRes = await client.query('SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE', [item.bookId, locationId]);
        if (!invRes.rows.length) throw new BusinessError('INSUFFICIENT_STOCK', 'No inventory for book ' + item.bookId);
        const qtyBefore = invRes.rows[0].quantity as number;
        const qtyAfter = qtyBefore - item.quantity;
        if (qtyAfter < 0) throw new BusinessError('INSUFFICIENT_STOCK', 'Insufficient stock for book ' + item.bookId);
        await client.query('UPDATE inventory SET quantity = $1, version = version + 1, updated_at = now() WHERE book_id = $2 AND location_id = $3', [qtyAfter, item.bookId, locationId]);
        await client.query("INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, reference_type, reference_id, notes, staff_id) VALUES ($1,$2,$3,$4,$5,'stock_out','stock_out','exchange_out',$6,'Exchange outgoing',$7)", [item.bookId, locationId, qtyBefore, qtyAfter, -item.quantity, exchangeId, staffCtx.staffId]);
      }
    }

    // Mark as Completed (settlement handled separately via POST /exchanges/:id/settle)
    await client.query("UPDATE exchanges SET status = 'Completed', updated_at = now() WHERE id = $1", [exchangeId]);

    await client.query("INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'CREATE','exchange',$3,$4,$5)", [staffCtx.staffId, staffCtx.role, exchangeId, staffCtx.branchId, JSON.stringify({ exchangeReference, totalIncoming, totalOutgoing, netBalance, settlementType })]);

    // Emit exchange notifications
    await insertOutbox(client, 'exchange.completed', {
      exchangeId, exchangeRef: exchangeReference, settlementType, netBalance, branchId: staffCtx.branchId,
    });
    if (settlementType === 'Store_Refunds') {
      await insertOutbox(client, 'exchange.store_refund_due', {
        exchangeId, exchangeRef: exchangeReference, amount: Math.abs(netBalance), branchId: staffCtx.branchId,
      });
    }

    await client.query('COMMIT');
    return getById(exchangeId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

export async function cancelExchange(id: string | number, staffCtx: StaffCtx): Promise<ExchangeRow> {
  const exchange = await getById(id);
  if (exchange.status === 'Completed') throw new BusinessError('ALREADY_COMPLETED', 'Cannot cancel a completed exchange');
  if (exchange.status === 'Cancelled') throw new BusinessError('ALREADY_CANCELLED', 'Exchange is already cancelled');
  await db.query("UPDATE exchanges SET status = 'Cancelled', updated_at = now() WHERE id = $1", [id]);
  await db.query("INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'UPDATE','exchange',$3,$4,$5)", [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ action: 'cancel' })]);

  try {
    const notifClient = await db.connect();
    try {
      await notifClient.query('BEGIN');
      await insertOutbox(notifClient, 'exchange.cancelled', {
        exchangeId: String(id), exchangeRef: exchange.exchangeReference, branchId: staffCtx.branchId,
      });
      await notifClient.query('COMMIT');
    } catch { await notifClient.query('ROLLBACK'); } finally { notifClient.release(); }
  } catch { /* non-fatal */ }

  return getById(id);
}
