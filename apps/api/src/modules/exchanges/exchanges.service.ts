import { db } from '../../db/index.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { insertOutbox } from '../../lib/outbox.js';
import type { Permission } from '../../lib/permissions.js';

export interface StaffCtx { staffId: number; role: string; branchId: number; permissions?: string[]; }

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
  lifecycleStatus?: string | null;
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
  allowedActions?: string[];
}

export interface ExchangeItemInput2 {
  bookId: number;
  quantity: number;
  unitPrice: number;
  type: 'returned' | 'new';
  condition?: 'resellable' | 'damaged'; // only for returned items
}

export interface SettlementEntry {
  entryType: 'cash_payment' | 'cash_refund' | 'item_value_adjustment';
  amount: number;
  currency?: string;
  method?: string;
  note?: string;
  overrideReason?: string;
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
    lifecycleStatus: (row.lifecycle_status as string | null) ?? null,
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
  exchange.allowedActions = [];
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
  // Check lifecycle_status for new-style exchanges
  if (exchange.lifecycleStatus === 'SETTLED' || exchange.lifecycleStatus === 'COMPLETED') {
    throw new BusinessError('EXCHANGE_NOT_CANCELLABLE', 'Cannot cancel a settled or completed exchange');
  }
  if (exchange.lifecycleStatus === 'CANCELLED') {
    throw new BusinessError('ALREADY_CANCELLED', 'Exchange is already cancelled');
  }
  await db.query("UPDATE exchanges SET status = 'Cancelled', lifecycle_status = 'CANCELLED', updated_at = now() WHERE id = $1", [id]);
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

// ── computeExchangeAllowedActions ─────────────────────────────────────────────

export function computeExchangeAllowedActions(
  lifecycleStatus: string | null,
  status: string,
  permissions: Permission[],
): string[] {
  const can = (p: Permission) => permissions.includes(p);
  const ls = lifecycleStatus ?? status; // fall back to legacy status
  switch (ls) {
    case 'INITIATED':
      return [
        ...(can('APPROVE_EXCHANGE') ? ['review'] : []),
        ...(can('APPROVE_EXCHANGE') || can('CREATE_SALE') ? ['cancel'] : []),
      ];
    case 'REVIEWED':
      return [...(can('APPROVE_EXCHANGE') ? ['approve', 'cancel'] : [])];
    case 'APPROVED':
      return [...(can('APPROVE_EXCHANGE') ? ['settle', 'cancel'] : [])];
    case 'SETTLED':
      return [];
    case 'COMPLETED':
      return ['print'];
    case 'CANCELLED':
      return [];
    // Legacy status values
    case 'Initiated':
      return [...(can('APPROVE_EXCHANGE') || can('CREATE_SALE') ? ['cancel'] : [])];
    case 'Evaluated':
      return [...(can('APPROVE_EXCHANGE') ? ['cancel'] : [])];
    case 'Completed':
      return ['print'];
    case 'Cancelled':
      return [];
    default:
      return [];
  }
}

// ── initiateExchange ──────────────────────────────────────────────────────────

export async function initiateExchange(
  data: {
    locationId?: number | null;
    customerId?: number | null;
    originalOrderId?: number | null;
    notes?: string;
    items: ExchangeItemInput2[];
  },
  staffCtx: StaffCtx,
): Promise<ExchangeRow> {
  if (!data.items || data.items.length === 0) {
    throw new ValidationError('Exchange must have at least one item');
  }

  // Validate all books exist and are active
  const allBookIds = data.items.map(i => i.bookId);
  for (const bookId of allBookIds) {
    const bookRes = await db.query('SELECT id, is_active FROM books WHERE id = $1', [bookId]);
    if (!bookRes.rows.length) throw new NotFoundError('Book ' + bookId);
    if (!bookRes.rows[0].is_active) throw new BusinessError('BOOK_INACTIVE', 'Book ' + bookId + ' is not active');
  }

  let resolvedCustomerId = data.customerId ?? null;

  // Validate original order if provided
  if (data.originalOrderId) {
    const orderRes = await db.query('SELECT id, status, customer_id FROM orders WHERE id = $1', [data.originalOrderId]);
    if (!orderRes.rows.length) throw new NotFoundError('Order ' + data.originalOrderId);
    const orderStatus = orderRes.rows[0].status as string;
    if (!['COMPLETED', 'FULFILLED', 'Completed', 'Fulfilled'].includes(orderStatus)) {
      throw new BusinessError('ORDER_NOT_ELIGIBLE', 'Original order must be in COMPLETED or FULFILLED status');
    }
    // Auto-inherit customer_id if not provided
    if (!resolvedCustomerId && orderRes.rows[0].customer_id) {
      resolvedCustomerId = orderRes.rows[0].customer_id as number;
    }
  }

  // Compute values
  const returnedItems = data.items.filter(i => i.type === 'returned');
  const newItems = data.items.filter(i => i.type === 'new');

  const totalReturnedValue = parseFloat(
    returnedItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0).toFixed(2),
  );
  const totalNewValue = parseFloat(
    newItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0).toFixed(2),
  );
  const netBalance = parseFloat((totalNewValue - totalReturnedValue).toFixed(2));

  let settlementType: 'Even' | 'Customer_Pays' | 'Store_Refunds';
  if (netBalance > 0.01) settlementType = 'Customer_Pays';
  else if (netBalance < -0.01) settlementType = 'Store_Refunds';
  else settlementType = 'Even';

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Generate exchange reference
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cntRes = await client.query('SELECT COUNT(*) FROM exchanges WHERE DATE(created_at) = CURRENT_DATE');
    const exchangeReference = 'EXC-' + dateStr + '-' + String(parseInt(cntRes.rows[0].count as string, 10) + 1).padStart(4, '0');

    // INSERT exchange with lifecycle_status = 'INITIATED'
    const excRes = await client.query(
      `INSERT INTO exchanges
         (exchange_reference, branch_id, location_id, customer_id, customer_id_v2,
          original_order_id, status, lifecycle_status,
          total_incoming_value, total_outgoing_value, net_balance,
          settlement_type, currency, notes, created_by)
       VALUES ($1,$2,$3,$4,$4,$5,'Evaluated','INITIATED',$6,$7,$8,$9,'ETB',$10,$11)
       RETURNING id`,
      [
        exchangeReference,
        staffCtx.branchId,
        data.locationId ?? null,
        resolvedCustomerId,
        data.originalOrderId ?? null,
        totalReturnedValue.toFixed(2),
        totalNewValue.toFixed(2),
        netBalance.toFixed(2),
        settlementType,
        data.notes ?? null,
        staffCtx.staffId,
      ],
    );
    const exchangeId = String(excRes.rows[0].id);

    // INSERT into exchange_items (unified table)
    for (const item of data.items) {
      const totalPrice = parseFloat((item.unitPrice * item.quantity).toFixed(2));
      const condition = item.type === 'returned' ? (item.condition ?? 'resellable') : 'resellable';
      await client.query(
        `INSERT INTO exchange_items (exchange_id, book_id, quantity, unit_price, total_price, type, condition)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [exchangeId, item.bookId, item.quantity, item.unitPrice.toFixed(2), totalPrice.toFixed(2), item.type, condition],
      );
    }

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1,$2,'CREATE','exchange',$3,$4,$5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        exchangeId,
        staffCtx.branchId,
        JSON.stringify({ action: 'initiate', lifecycleStatus: 'INITIATED', exchangeReference }),
      ],
    );

    // Outbox event
    await insertOutbox(client, 'exchange.initiated', {
      exchangeId,
      exchangeRef: exchangeReference,
      settlementType,
      netBalance,
      branchId: staffCtx.branchId,
    });

    await client.query('COMMIT');
    return getById(exchangeId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── reviewExchange ────────────────────────────────────────────────────────────

export async function reviewExchange(exchangeId: string | number, staffCtx: StaffCtx): Promise<ExchangeRow> {
  const exchange = await getById(exchangeId);
  if (exchange.lifecycleStatus !== 'INITIATED') {
    throw new BusinessError('INVALID_LIFECYCLE_TRANSITION', `Exchange must be in INITIATED status to review. Current: ${exchange.lifecycleStatus}`);
  }

  // Recompute difference from exchange_items
  const itemsRes = await db.query(
    `SELECT type, SUM(total_price) AS total FROM exchange_items WHERE exchange_id = $1 GROUP BY type`,
    [exchangeId],
  );
  let returnedTotal = 0;
  let newTotal = 0;
  for (const row of itemsRes.rows) {
    if (row.type === 'returned') returnedTotal = parseFloat(row.total as string);
    if (row.type === 'new') newTotal = parseFloat(row.total as string);
  }
  const netBalance = parseFloat((newTotal - returnedTotal).toFixed(2));

  let settlementType: 'Even' | 'Customer_Pays' | 'Store_Refunds';
  if (netBalance > 0.01) settlementType = 'Customer_Pays';
  else if (netBalance < -0.01) settlementType = 'Store_Refunds';
  else settlementType = 'Even';

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE exchanges
       SET lifecycle_status = 'REVIEWED',
           total_incoming_value = $1,
           total_outgoing_value = $2,
           net_balance = $3,
           settlement_type = $4,
           updated_at = now()
       WHERE id = $5`,
      [returnedTotal.toFixed(2), newTotal.toFixed(2), netBalance.toFixed(2), settlementType, exchangeId],
    );

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1,$2,'UPDATE','exchange',$3,$4,$5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(exchangeId),
        staffCtx.branchId,
        JSON.stringify({ action: 'review', lifecycleStatus: 'REVIEWED', netBalance }),
      ],
    );

    await insertOutbox(client, 'exchange.reviewed', {
      exchangeId: String(exchangeId),
      exchangeRef: exchange.exchangeReference,
      branchId: staffCtx.branchId,
    });

    await client.query('COMMIT');
    return getById(exchangeId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── approveExchange ───────────────────────────────────────────────────────────

export async function approveExchange(exchangeId: string | number, staffCtx: StaffCtx): Promise<ExchangeRow> {
  const exchange = await getById(exchangeId);
  if (exchange.lifecycleStatus !== 'REVIEWED') {
    throw new BusinessError('INVALID_LIFECYCLE_TRANSITION', `Exchange must be in REVIEWED status to approve. Current: ${exchange.lifecycleStatus}`);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE exchanges SET lifecycle_status = 'APPROVED', updated_at = now() WHERE id = $1`,
      [exchangeId],
    );

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1,$2,'UPDATE','exchange',$3,$4,$5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(exchangeId),
        staffCtx.branchId,
        JSON.stringify({ action: 'approve', lifecycleStatus: 'APPROVED' }),
      ],
    );

    await insertOutbox(client, 'exchange.approved', {
      exchangeId: String(exchangeId),
      exchangeRef: exchange.exchangeReference,
      branchId: staffCtx.branchId,
    });

    await client.query('COMMIT');
    return getById(exchangeId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── settleExchange ────────────────────────────────────────────────────────────

export async function settleExchange(
  exchangeId: string | number,
  entries: SettlementEntry[],
  idempotencyKey: string,
  staffCtx: StaffCtx,
): Promise<ExchangeRow> {
  const exchange = await getById(exchangeId);
  if (exchange.lifecycleStatus !== 'APPROVED') {
    throw new BusinessError('INVALID_LIFECYCLE_TRANSITION', `Exchange must be in APPROVED status to settle. Current: ${exchange.lifecycleStatus}`);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Idempotency check: if settlement entries already exist for this exchange, return existing
    const existingEntries = await client.query(
      `SELECT id FROM exchange_settlement_entries WHERE exchange_id = $1 LIMIT 1`,
      [exchangeId],
    );
    if (existingEntries.rows.length > 0) {
      await client.query('ROLLBACK');
      return getById(exchangeId);
    }

    // Load exchange_items for this exchange
    const itemsRes = await client.query(
      `SELECT ei.*, b.title AS book_title
       FROM exchange_items ei
       JOIN books b ON b.id = ei.book_id
       WHERE ei.exchange_id = $1`,
      [exchangeId],
    );
    const exchangeItems = itemsRes.rows;

    // Validate settlement balance
    const sum = entries.reduce((acc, e) => {
      if (e.entryType === 'cash_payment') return acc + e.amount;
      if (e.entryType === 'cash_refund') return acc - e.amount;
      if (e.entryType === 'item_value_adjustment') return acc + e.amount;
      return acc;
    }, 0);

    if (Math.abs(sum - exchange.netBalance) > 0.01) {
      await client.query('ROLLBACK');
      throw new BusinessError(
        'SETTLEMENT_UNBALANCED',
        `Settlement entries sum (${sum.toFixed(2)}) does not match exchange net balance (${exchange.netBalance.toFixed(2)})`,
        { sum, netBalance: exchange.netBalance },
      );
    }

    const locationId = exchange.locationId;

    // Process inventory changes for each item
    for (const item of exchangeItems) {
      const bookId = item.book_id as number;
      const qty = item.quantity as number;
      const itemType = item.type as string;
      const condition = item.condition as string;

      if (itemType === 'returned') {
        if (locationId) {
          // Ensure inventory row exists
          await client.query(
            `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
             VALUES ($1,$2,0,5,0)
             ON CONFLICT (book_id, location_id) DO NOTHING`,
            [bookId, locationId],
          );

          if (condition === 'resellable') {
            const invRes = await client.query(
              `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE`,
              [bookId, locationId],
            );
            const qtyBefore = invRes.rows[0]?.quantity ?? 0;
            await client.query(
              `UPDATE inventory SET quantity = quantity + $1, updated_at = now() WHERE book_id = $2 AND location_id = $3`,
              [qty, bookId, locationId],
            );
            await client.query(
              `INSERT INTO inventory_history
                 (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, reference_type, reference_id, notes, staff_id)
               VALUES ($1,$2,$3,$4,$5,'stock_in','stock_in','exchange_in',$6,'Exchange returned resellable',$7)`,
              [bookId, locationId, qtyBefore, qtyBefore + qty, qty, String(exchangeId), staffCtx.staffId],
            );
          } else if (condition === 'damaged') {
            const invRes = await client.query(
              `SELECT damaged_quantity FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE`,
              [bookId, locationId],
            );
            const dmgBefore = invRes.rows[0]?.damaged_quantity ?? 0;
            await client.query(
              `UPDATE inventory SET damaged_quantity = damaged_quantity + $1, updated_at = now() WHERE book_id = $2 AND location_id = $3`,
              [qty, bookId, locationId],
            );
            await client.query(
              `INSERT INTO inventory_history
                 (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, reference_type, reference_id, notes, staff_id)
               VALUES ($1,$2,$3,$4,$5,'stock_in','stock_in','exchange_damaged',$6,'Exchange returned damaged',$7)`,
              [bookId, locationId, dmgBefore, dmgBefore + qty, qty, String(exchangeId), staffCtx.staffId],
            );
          }
        }
      } else if (itemType === 'new') {
        if (locationId) {
          const invRes = await client.query(
            `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE`,
            [bookId, locationId],
          );
          const available = invRes.rows[0]?.quantity ?? 0;
          if (available < qty) {
            await client.query('ROLLBACK');
            throw new BusinessError(
              'INSUFFICIENT_STOCK',
              `Insufficient stock for book ${bookId}. Available: ${available}, requested: ${qty}`,
              { available, requested: qty },
            );
          }
          await client.query(
            `UPDATE inventory SET quantity = quantity - $1, updated_at = now() WHERE book_id = $2 AND location_id = $3`,
            [qty, bookId, locationId],
          );
          await client.query(
            `INSERT INTO inventory_history
               (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, reference_type, reference_id, notes, staff_id)
             VALUES ($1,$2,$3,$4,$5,'stock_out','stock_out','exchange_out',$6,'Exchange new item issued',$7)`,
            [bookId, locationId, available, available - qty, -qty, String(exchangeId), staffCtx.staffId],
          );
        }
      }
    }

    // INSERT exchange_settlement_entries
    for (const entry of entries) {
      await client.query(
        `INSERT INTO exchange_settlement_entries
           (exchange_id, entry_type, amount, currency, method, note, override_reason, authorised_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          exchangeId,
          entry.entryType,
          entry.amount.toFixed(2),
          entry.currency ?? 'ETB',
          entry.method ?? null,
          entry.note ?? null,
          entry.overrideReason ?? null,
          staffCtx.staffId,
        ],
      );
    }

    // INSERT financial_transactions for cash entries
    for (const entry of entries) {
      let txType: 'payment' | 'refund' | 'adjustment';
      if (entry.entryType === 'cash_payment') txType = 'payment';
      else if (entry.entryType === 'cash_refund') txType = 'refund';
      else txType = 'adjustment';

      const ftKey = `${idempotencyKey}-${entry.entryType}-${entry.amount}`;
      await client.query(
        `INSERT INTO financial_transactions
           (type, exchange_id, idempotency_key, amount, currency, method, staff_id, branch_id, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          txType,
          exchangeId,
          ftKey,
          entry.amount.toFixed(2),
          entry.currency ?? 'ETB',
          entry.method ?? null,
          staffCtx.staffId,
          staffCtx.branchId,
          JSON.stringify({ entryType: entry.entryType, note: entry.note }),
        ],
      );
    }

    // UPDATE lifecycle_status to SETTLED then COMPLETED (auto-complete)
    await client.query(
      `UPDATE exchanges SET lifecycle_status = 'SETTLED', status = 'Completed', updated_at = now() WHERE id = $1`,
      [exchangeId],
    );
    await client.query(
      `UPDATE exchanges SET lifecycle_status = 'COMPLETED', updated_at = now() WHERE id = $1`,
      [exchangeId],
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1,$2,'UPDATE','exchange',$3,$4,$5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(exchangeId),
        staffCtx.branchId,
        JSON.stringify({ action: 'settle', lifecycleStatus: 'COMPLETED', idempotencyKey }),
      ],
    );

    // ── Customer store credit integration ────────────────────────────────────
    // When the store owes the customer (Store_Refunds), credit their store credit account.
    // When the customer owes the store (Customer_Pays), record the debt in store credit history.
    if (exchange.customerId) {
      const absBalance = Math.abs(exchange.netBalance);
      if (absBalance > 0.01) {
        // Ensure store_credit_accounts row exists
        await client.query(
          `INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 0)
           ON CONFLICT (customer_id) DO NOTHING`,
          [exchange.customerId],
        );

        if (exchange.settlementType === 'Store_Refunds') {
          // Store owes customer — add to their store credit balance
          await client.query(
            `UPDATE store_credit_accounts SET balance = balance + $1 WHERE customer_id = $2`,
            [absBalance.toFixed(2), exchange.customerId],
          );
          await client.query(
            `INSERT INTO store_credit_history (customer_id, ref_type, ref_id, amount, direction)
             VALUES ($1, 'exchange_refund', $2, $3, 'credit')`,
            [exchange.customerId, exchange.exchangeReference, absBalance.toFixed(2)],
          );
        } else if (exchange.settlementType === 'Customer_Pays') {
          // Customer owes store — record as debt in store credit history (informational)
          await client.query(
            `INSERT INTO store_credit_history (customer_id, ref_type, ref_id, amount, direction)
             VALUES ($1, 'exchange_payment', $2, $3, 'debit')`,
            [exchange.customerId, exchange.exchangeReference, absBalance.toFixed(2)],
          );
        }
      }
    }

    // Outbox events
    await insertOutbox(client, 'exchange.settled', {
      exchangeId: String(exchangeId),
      exchangeRef: exchange.exchangeReference,
      branchId: staffCtx.branchId,
    });
    await insertOutbox(client, 'exchange.completed', {
      exchangeId: String(exchangeId),
      exchangeRef: exchange.exchangeReference,
      settlementType: exchange.settlementType,
      netBalance: exchange.netBalance,
      branchId: staffCtx.branchId,
    });

    await client.query('COMMIT');
    return getById(exchangeId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
