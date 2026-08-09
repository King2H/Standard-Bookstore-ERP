import pg from 'pg';
import { db } from '../../db/index.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { getMaxLineDiscountPct, isNegativeStockAllowed } from '../config/config.service.js';
import { insertOutbox } from '../../lib/outbox.js';
import { Permission } from '../../lib/permissions.js';
import {
  resolveDiscountFields,
  enforceDiscountCap,
  type DiscountType,
  type DiscountMode,
} from '../../lib/discount.js';
import {
  createReceivable,
  updateReceivableOnPayment,
} from '../receivables/receivables.service.js';
import * as invTxSvc from '../inventory/inventoryTransaction.service.js';

// ── Status value compatibility ────────────────────────────────────────────────
// Migration 33 extends the orders.status CHECK constraint to include new lifecycle
// values (DRAFT, CONFIRMED, PAID, etc.). On DBs where migration 33 hasn't run yet,
// we fall back to the legacy values (Pending, Confirmed, etc.).
// Checked once and cached for the process lifetime.
let _usesNewStatusValues: boolean | null = null;
async function usesNewStatusValues(): Promise<boolean> {
  if (_usesNewStatusValues !== null) return _usesNewStatusValues;
  try {
    const r = await db.query(
      `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'orders' AND c.conname = 'orders_status_check'`,
    );
    const def: string = r.rows[0]?.def ?? '';
    _usesNewStatusValues = def.includes("'DRAFT'");
  } catch {
    _usesNewStatusValues = false;
  }
  return _usesNewStatusValues;
}

// Map new lifecycle status → legacy status (for DBs without migration 33)
const NEW_TO_LEGACY: Record<string, string> = {
  DRAFT:     'Pending',
  CONFIRMED: 'Confirmed',
  PAID:      'Confirmed',   // no PAID in legacy — treat as Confirmed
  FULFILLED: 'Fulfilled',
  COMPLETED: 'Fulfilled',
  CANCELLED: 'Cancelled',
};

// Map legacy status → new lifecycle status (for display/logic)
const LEGACY_TO_NEW: Record<string, string> = {
  Pending:     'DRAFT',
  Confirmed:   'CONFIRMED',
  In_Progress: 'CONFIRMED',
  Fulfilled:   'FULFILLED',
  Cancelled:   'CANCELLED',
};

/** Normalise any status value to the new lifecycle format for business logic. */
function normaliseStatus(status: string): string {
  return LEGACY_TO_NEW[status] ?? status;
}

/** Get the status value to write to the DB, respecting the constraint. */
async function dbStatus(newStatus: string): Promise<string> {
  if (await usesNewStatusValues()) return newStatus;
  return NEW_TO_LEGACY[newStatus] ?? newStatus;
}

export interface StaffCtx { staffId: number; role: string; branchId: number; }
export interface OrderLineInput {
  bookId: number;
  quantity: number;
  /** Legacy plain override — used when discountMode is absent or 'Amount' */
  discountAmount?: number;
  /** Percentage 0–100 (used when discountMode = 'Percentage') */
  discountPct?: number;
  discountType?: DiscountType;
  discountMode?: DiscountMode;
}

export interface OrderRow {
  id: string; orderNumber: string; customerId: number | null; branchId: number;
  locationId: number | null; channel: string; status: string; paymentStatus: string;
  saleType: 'cash_sale' | 'credit_sale';
  currency: string; subtotal: number; discountAmount: number; discountTotal: number;
  taxRate: number; taxAmount: number; total: number;
  cancelReason: string | null; notes: string | null;
  createdBy: number; createdAt: string; updatedAt: string; lineItems?: OrderLineItemRow[];
  allowedActions?: string[];
  /** Payment method recorded for this order (cash orders: at confirm; populated via getById()'s subquery). */
  paymentMethod?: string | null;
  /** Credit sale due date (YYYY-MM-DD), sourced from the linked receivable; populated via getById()'s subquery. */
  dueDate?: string | null;
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
    saleType: ((row.sale_type as string | undefined) ?? 'cash_sale') as 'cash_sale' | 'credit_sale',
    currency: row.currency as string, subtotal: parseFloat(row.subtotal as string),
    discountAmount: parseFloat(row.discount_amount as string),
    discountTotal: parseFloat((row.discount_total as string | undefined) ?? '0'),
    taxRate: parseFloat(row.tax_rate as string),
    taxAmount: parseFloat(row.tax_amount as string), total: parseFloat(row.total as string),
    cancelReason: (row.cancel_reason as string | null) ?? null, notes: (row.notes as string | null) ?? null,
    createdBy: row.created_by as number,
    createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString(),
    paymentMethod: (row.payment_method as string | null | undefined) ?? null,
    dueDate: (row.due_date as string | null | undefined) ?? null,
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
  const res = await db.query(
    `SELECT o.*,
       (SELECT op.payment_method FROM order_payments op WHERE op.order_id = o.id ORDER BY op.created_at ASC LIMIT 1) AS payment_method,
       (SELECT TO_CHAR(r.due_date, 'YYYY-MM-DD') FROM receivables r WHERE r.source_type = 'order_credit_sale' AND r.source_entity_id = o.id LIMIT 1) AS due_date
     FROM orders o WHERE o.id = $1`,
    [id],
  );
  if (!res.rows.length) throw new NotFoundError('Order');
  const order = mapOrderRow(res.rows[0]);
  order.lineItems = await fetchLineItems(order.id);
  order.allowedActions = [];
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
  // Module 6: accept a comma-separated status list (dashboard drill-downs pass
  // multiple statuses, e.g. "CONFIRMED,PAID") alongside the single-value case.
  if (opts.status) {
    const statuses = opts.status.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length > 1) {
      params.push(statuses); conditions.push('o.status = ANY($' + params.length + '::text[])');
    } else if (statuses.length === 1) {
      params.push(statuses[0]); conditions.push('o.status = $' + params.length);
    }
  }
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
  const items = dataRes.rows.map(r => ({ ...mapOrderRow(r), allowedActions: [] as string[] }));
  return { items, total: parseInt(countRes.rows[0].count, 10), page, totalPages: Math.ceil(parseInt(countRes.rows[0].count, 10) / pageSize) };
}

export async function create(
  data: {
    customerId?: number | null;
    locationId?: number | null;
    channel?: string;
    notes?: string;
    saleType?: 'cash_sale' | 'credit_sale';
    items: OrderLineInput[];
  },
  staffCtx: StaffCtx,
): Promise<OrderRow> {
  if (!data.items || data.items.length === 0) throw new ValidationError('At least one item is required');

  const saleType = data.saleType ?? 'cash_sale';

  // Credit sales require a customer
  if (saleType === 'credit_sale' && !data.customerId) {
    throw new BusinessError('CREDIT_REQUIRES_CUSTOMER', 'Credit sales require a customer to be selected');
  }

  interface RI {
    bookId: number; quantity: number; unitPrice: number;
    discountAmount: number; discountPct: number;
    discountType: DiscountType; discountMode: DiscountMode;
    totalPrice: number;
  }
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

  // Fetch max discount cap once (per-role)
  const maxDiscPct = await getMaxLineDiscountPct(staffCtx.branchId, staffCtx.role);

  for (const item of data.items) {
    // Bug Sweep: quantity had no application-level bound — a zero/negative
    // value fell through to order_line_items' CHECK (quantity > 0), which
    // the error handler doesn't recognize as an AppError, surfacing as a
    // raw 500 instead of a clean 400.
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new ValidationError(`Quantity for book ${item.bookId} must be a positive integer`);
    }

    const bookRes = await db.query('SELECT id, title, is_active FROM books WHERE id = $1', [item.bookId]);
    if (!bookRes.rows.length) throw new NotFoundError('Book ' + item.bookId);
    const book = bookRes.rows[0];
    if (!book.is_active) throw new BusinessError('BOOK_INACTIVE', 'Book ' + item.bookId + ' is not active');

    const priceRes = await db.query(
      'SELECT COALESCE(bbp.price, b.default_price) AS price FROM books b LEFT JOIN book_branch_prices bbp ON bbp.book_id = b.id AND bbp.branch_id = $2 AND bbp.format_id = 0 AND bbp.edition_id = 0 WHERE b.id = $1',
      [item.bookId, staffCtx.branchId],
    );
    const unitPrice = priceRes.rows[0]?.price != null ? parseFloat(priceRes.rows[0].price) : null;
    if (unitPrice === null) throw new BusinessError('PRICE_NOT_SET', 'Price not set for book ' + item.bookId);

    // ── Discount resolution ───────────────────────────────────────────────────
    // If the caller sends discountPct / discountType / discountMode, use the
    // shared discount engine.  Fall back to legacy discountAmount-only path.
    let resolvedDiscount: { discountPct: number; discountAmount: number; discountType: DiscountType; discountMode: DiscountMode };

    const hasEngineFields = item.discountMode != null || item.discountType != null || item.discountPct != null;

    if (hasEngineFields) {
      const mode: DiscountMode = item.discountMode ?? 'Percentage';
      const type: DiscountType = item.discountType ?? 'Normal';
      const value = mode === 'Amount'
        ? (item.discountAmount ?? 0)
        : (item.discountPct ?? 0);

      resolvedDiscount = resolveDiscountFields(
        { unitPrice, quantity: item.quantity },
        mode,
        value,
        type,
      );
      // Enforce max-discount cap
      enforceDiscountCap(resolvedDiscount.discountPct, maxDiscPct);
    } else {
      // Backward-compatible: plain discountAmount only.
      // Bug Sweep: clamp to 0 — a negative discountAmount was passed
      // straight through, which (since totalPrice = unitPrice*qty -
      // discountAmount) would INCREASE the line total rather than
      // discount it. Mirrors the clamp resolveDiscountFields() already
      // applies on the engine-fields path above.
      const discountAmount = Math.max(0, parseFloat((item.discountAmount ?? 0).toFixed(2)));
      const lineValue = unitPrice * item.quantity;
      const discountPct = lineValue > 0
        ? Math.round((discountAmount / lineValue) * 10000) / 100
        : 0;
      resolvedDiscount = {
        discountAmount,
        discountPct,
        discountType: 'Normal',
        discountMode: 'Amount',
      };
    }

    const totalPrice = parseFloat((unitPrice * item.quantity - resolvedDiscount.discountAmount).toFixed(2));
    resolvedItems.push({
      bookId: item.bookId,
      quantity: item.quantity,
      unitPrice,
      discountAmount: resolvedDiscount.discountAmount,
      discountPct: resolvedDiscount.discountPct,
      discountType: resolvedDiscount.discountType,
      discountMode: resolvedDiscount.discountMode,
      totalPrice,
    });
  }

  const subtotal = parseFloat(resolvedItems.reduce((s, i) => s + i.totalPrice, 0).toFixed(2));
  const discountTotal = parseFloat(resolvedItems.reduce((s, i) => s + i.discountAmount, 0).toFixed(2));
  // Tax is disabled for this phase — order total = subtotal (discounts already applied per line)
  const taxRate = 0;
  const taxAmount = 0;
  const total = subtotal;
  const initialStatus = await dbStatus('DRAFT');

  // ── Stock visibility: cannot order more than available branch inventory ──
  // A DRAFT order doesn't reserve or deduct stock yet (confirm() does that,
  // with its own row-locked, authoritative INSUFFICIENT_STOCK check below,
  // unchanged) — so a plain read-only availability check here is enough: it
  // just stops the order from ever being created oversold in the first
  // place, closer to where the user is adding items, instead of only
  // surfacing as a confusing error much later at confirm.
  if (!(await isNegativeStockAllowed())) {
    const effectiveLocationId = await resolveEffectiveLocationId(data.locationId ?? null, staffCtx.branchId);
    for (const item of resolvedItems) {
      const stock = await invTxSvc.getAvailableStock(item.bookId, effectiveLocationId);
      if (stock.available < item.quantity) {
        const bookRes = await db.query('SELECT title FROM books WHERE id = $1', [item.bookId]);
        const bookTitle = (bookRes.rows[0]?.title as string | undefined) ?? `Book ${item.bookId}`;
        throw new BusinessError(
          'INSUFFICIENT_STOCK',
          `Insufficient stock for "${bookTitle}". Available: ${stock.available}, Requested: ${item.quantity}`,
        );
      }
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Module 9: derive the date-stamp from the DB's own CURRENT_DATE instead
    // of Node's new Date() (always UTC via toISOString()). The sequence
    // count below is already scoped to CURRENT_DATE — computing the visible
    // date-stamp from a separate, JS-side UTC clock let the two drift apart
    // whenever the DB session timezone differs from UTC (e.g. EAT, UTC+3):
    // during the first few hours of each local day the reference number
    // would show yesterday's date while the counter had already rolled over.
    const cntRes = await client.query(
      `SELECT COUNT(*) AS count, TO_CHAR(CURRENT_DATE, 'YYYYMMDD') AS date_str FROM orders WHERE DATE(created_at) = CURRENT_DATE`,
    );
    const dateStr = cntRes.rows[0].date_str as string;
    const orderNumber = 'ORD-' + dateStr + '-' + String(parseInt(cntRes.rows[0].count, 10) + 1).padStart(4, '0');
    const orderRes = await client.query(
      `INSERT INTO orders
         (order_number, customer_id, branch_id, location_id, channel, status, payment_status,
          currency, subtotal, discount_amount, discount_total, tax_rate, tax_amount, total,
          sale_type, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'unpaid','ETB',$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        orderNumber,
        data.customerId ?? null,
        staffCtx.branchId,
        data.locationId ?? null,
        data.channel ?? 'in_store',
        initialStatus,
        subtotal.toFixed(2),
        discountTotal.toFixed(2),
        discountTotal.toFixed(2),   // discount_total mirrors discount_amount header
        taxRate.toFixed(4),
        taxAmount.toFixed(2),
        total.toFixed(2),
        saleType,
        data.notes ?? null,
        staffCtx.staffId,
      ],
    );
    const orderId = String(orderRes.rows[0].id);

    for (const item of resolvedItems) {
      await client.query(
        `INSERT INTO order_line_items
           (order_id, book_id, quantity, unit_price, discount_amount, total_price,
            discount_pct, discount_type, discount_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          orderId,
          item.bookId,
          item.quantity,
          item.unitPrice.toFixed(2),
          item.discountAmount.toFixed(2),
          item.totalPrice.toFixed(2),
          item.discountPct.toFixed(4),
          item.discountType,
          item.discountMode,
        ],
      );
    }

    await client.query(
      "INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'CREATE','order',$3,$4,$5)",
      [staffCtx.staffId, staffCtx.role, orderId, staffCtx.branchId,
       JSON.stringify({ orderNumber, total, saleType, itemCount: resolvedItems.length })],
    );
    await insertOutbox(client, 'order.created', {
      orderId, orderNumber, branchId: staffCtx.branchId, total, saleType,
      channel: data.channel ?? 'in_store',
    });
    await client.query('COMMIT');
    return getById(orderId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

// Standalone counterpart to resolveLocationId() below, usable before an
// OrderRow/transaction exists (e.g. from create(), pre-INSERT). Same
// fallback chain: explicit locationId → branch default-fulfillment location
// → any location in the branch → branchId itself. Uses the plain `db` pool
// since it only ever runs outside a transaction.
async function resolveEffectiveLocationId(locationId: number | null, branchId: number): Promise<number> {
  if (locationId) return locationId;
  const defRes = await db.query(
    'SELECT id FROM locations WHERE branch_id = $1 AND is_default_fulfillment = true LIMIT 1',
    [branchId],
  );
  if (defRes.rows.length) return defRes.rows[0].id as number;
  const anyRes = await db.query(
    'SELECT id FROM locations WHERE branch_id = $1 ORDER BY id LIMIT 1',
    [branchId],
  );
  if (anyRes.rows.length) return anyRes.rows[0].id as number;
  return branchId;
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

const CASH_PAYMENT_METHODS = ['cash', 'bank', 'mobile', 'store_credit'] as const;

export async function confirm(
  orderId: string | number,
  staffCtx: StaffCtx,
  dueDate?: string | null,
  paymentMethod?: string | null,
): Promise<OrderRow> {
  const order = await getById(orderId);
  if (normaliseStatus(order.status) !== 'DRAFT') throw new BusinessError('INVALID_STATE', "Cannot confirm order in status '" + order.status + "'");

  // Module 4: a credit order must carry a due date on the receivable it is
  // about to create — otherwise the receivable is un-chaseable (never goes
  // Overdue, never surfaces on aging reports). Required up front, before the
  // transaction opens, so a missing date fails fast without touching stock.
  if (order.saleType === 'credit_sale' && order.customerId) {
    if (!dueDate) {
      throw new ValidationError('due_date is required to confirm a credit sale order');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      throw new ValidationError('due_date must be in YYYY-MM-DD format');
    }
    // Due date must be today or later. Compared as ISO YYYY-MM-DD strings
    // (both zero-padded) so this never round-trips through a JS Date object
    // — TO_CHAR(CURRENT_DATE, ...) reads the DB session's own local date,
    // avoiding the UTC-shift bugs a Date().toISOString() comparison would
    // introduce for non-UTC server timezones (e.g. Africa/Addis_Ababa).
    const todayRes = await db.query(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
    const today = todayRes.rows[0].today as string;
    if (dueDate < today) {
      throw new ValidationError(`due_date must be today (${today}) or later`);
    }
  }

  // Payment Mode Capture: every cash order must have a payment method
  // persisted against it — the Create Order confirm form (OrdersPage.tsx)
  // requires the staff member to pick one before it will submit. Callers
  // that don't supply one (older/other integration points, e.g. programmatic
  // confirms elsewhere in the app) fall back to 'cash', matching the
  // "cash order" naming itself — the method is still always recorded,
  // it's just assumed to be cash absent a more specific selection, so this
  // never becomes a caller-breaking hard requirement at the API layer.
  let effectivePaymentMethod: string | null = null;
  if (order.saleType === 'cash_sale') {
    effectivePaymentMethod = paymentMethod || 'cash';
    if (!(CASH_PAYMENT_METHODS as readonly string[]).includes(effectivePaymentMethod)) {
      throw new ValidationError(`payment_method must be one of: ${CASH_PAYMENT_METHODS.join(', ')}`);
    }
    if (effectivePaymentMethod === 'store_credit' && !order.customerId) {
      throw new BusinessError('STORE_CREDIT_REQUIRES_CUSTOMER', 'Store credit payment requires a customer to be selected');
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locationId = await resolveLocationId(client, order, staffCtx);

    // Check if inventory_reservations table exists (migration 33 may not have run)
    let hasReservationsTable = false;
    try {
      const tblCheck = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='inventory_reservations' LIMIT 1`,
      );
      hasReservationsTable = tblCheck.rows.length > 0;
    } catch { /* non-fatal */ }

    for (const item of order.lineItems ?? []) {
      // ── Business rule: CONFIRM = stockOut + soft reservation ─────────────────
      // 1. Validate reservation-aware availability (throws INSUFFICIENT_STOCK if short)
      // 2. Create the soft reservation record (for fulfillReservation() compatibility)
      // 3. Mark qty_reserved on the line item
      // 4. Call invTxSvc.stockOut() to physically decrement inventory.quantity

      // Acquire row lock and check reservation-aware availability (Requirement 2.3)
      await client.query(
        `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE`,
        [item.bookId, locationId],
      );
      const stock = await invTxSvc.getAvailableStock(item.bookId, locationId, client);
      const allowNeg = await isNegativeStockAllowed();
      if (!allowNeg && stock.available < item.quantity) {
        const bookRes = await client.query('SELECT title FROM books WHERE id = $1', [item.bookId]);
        const bookTitle = (bookRes.rows[0]?.title as string | undefined) ?? `Book ${item.bookId}`;
        const locRes = await client.query('SELECT name FROM locations WHERE id = $1', [locationId]);
        const locName = (locRes.rows[0]?.name as string | undefined) ?? `Location ${locationId}`;
        throw new BusinessError(
          'INSUFFICIENT_STOCK',
          `Insufficient stock for "${bookTitle}" at ${locName}. Available: ${stock.available}, Requested: ${item.quantity}`,
        );
      }

      // Mark line item as reserved.
      await client.query('UPDATE order_line_items SET qty_reserved = $1 WHERE id = $2', [item.quantity, item.id]);

      // Insert soft reservation record (only if table exists — graceful degradation).
      if (hasReservationsTable) {
        try {
          await client.query(
            "INSERT INTO inventory_reservations (order_id, book_id, location_id, quantity, status) VALUES ($1, $2, $3, $4, 'reserved')",
            [orderId, item.bookId, locationId, item.quantity],
          );
        } catch (invResErr) {
          const msg = (invResErr as { message?: string }).message ?? '';
          if (!msg.toLowerCase().includes('inventory_reservations')) throw invResErr;
        }
      }

      // ── Fix 9.1: Physically deduct stock at confirm() time ────────────────
      // CONFIRM = stockOut. inventory.quantity is decremented exactly once here.
      // fulfill() calls fulfillReservation() which writes audit rows (delta=0)
      // without a second deduction.
      await invTxSvc.stockOut(
        {
          bookId: item.bookId,
          locationId,
          quantity: item.quantity,
          referenceType: 'order_confirmed',
          referenceId: orderId,
          reasonCode: 'correction',
          notes: `Order confirmation – order ${String(orderId)}`,
          staffCtx,
        },
        client,
      );
    }

    // ── Fix 9.1 (CASH): set payment_status = 'paid' atomically at confirmation ──
    if (order.saleType === 'cash_sale') {
      await client.query("UPDATE orders SET payment_status = 'paid', updated_at = now() WHERE id = $1", [orderId]);

      // ── Payment Mode Capture: persist the payment method as an order_payments
      // record. This is a system-recorded side effect of confirmation (the
      // order is paid in full immediately) — distinct from the Payments
      // module's manual collection flow, which paymentsService.createPayment()
      // already refuses for cash_sale orders (CASH_ORDER_ALREADY_PAID).
      if (effectivePaymentMethod === 'store_credit') {
        const scRes = await client.query(
          'SELECT balance FROM store_credit_accounts WHERE customer_id = $1 FOR UPDATE',
          [order.customerId],
        );
        const available = scRes.rows.length ? parseFloat(scRes.rows[0].balance as string) : 0;
        if (available < order.total - 0.01) {
          throw new BusinessError(
            'INSUFFICIENT_STORE_CREDIT',
            `Insufficient store credit. Available: ETB ${available.toFixed(2)}, requested: ETB ${order.total.toFixed(2)}`,
            { available, requested: order.total },
          );
        }
        await client.query(
          'UPDATE store_credit_accounts SET balance = balance - $1 WHERE customer_id = $2',
          [order.total.toFixed(2), order.customerId],
        );
        await client.query(
          `INSERT INTO store_credit_history (customer_id, ref_type, ref_id, amount, direction)
           VALUES ($1, 'order_cash_sale', $2, $3, 'debit')`,
          [order.customerId, String(orderId), order.total.toFixed(2)],
        );
      }

      const payCntRes = await client.query(
        `SELECT COUNT(*) AS count, TO_CHAR(CURRENT_DATE, 'YYYYMMDD') AS date_str FROM order_payments WHERE DATE(created_at) = CURRENT_DATE`,
      );
      const payDateStr = payCntRes.rows[0].date_str as string;
      const paymentReference = 'PAY-' + payDateStr + '-' + String(parseInt(payCntRes.rows[0].count, 10) + 1).padStart(4, '0');
      await client.query(
        `INSERT INTO order_payments
           (payment_reference, order_id, amount, currency, payment_method, status, notes, processed_by)
         VALUES ($1, $2, $3, 'ETB', $4, 'success', $5, $6)`,
        [paymentReference, orderId, order.total.toFixed(2), effectivePaymentMethod, 'Recorded at order confirmation', staffCtx.staffId],
      );
    }

    const confirmedStatus = await dbStatus('CONFIRMED');
    await client.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [confirmedStatus, orderId]);
    await client.query(
      "INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'UPDATE','order',$3,$4,$5)",
      [staffCtx.staffId, staffCtx.role, String(orderId), staffCtx.branchId,
       JSON.stringify({ action: 'confirm', fromStatus: 'DRAFT', toStatus: 'CONFIRMED' })],
    );
    await insertOutbox(client, 'order.confirmed', { orderId: String(orderId), orderNumber: order.orderNumber, branchId: staffCtx.branchId });

    // ── Create receivable for CREDIT orders ──────────────────────────────────
    // CASH orders have payment_status = 'paid' already set above — no receivable.
    // CREDIT orders: hard-fail if receivable creation fails (no savepoint).
    if (order.saleType === 'credit_sale' && order.customerId) {
      const paidRes = await client.query(
        "SELECT COALESCE(SUM(amount),0) AS total_paid FROM order_payments WHERE order_id = $1 AND status IN ('success','partially_refunded','refunded')",
        [orderId],
      );
      const totalAlreadyPaid = parseFloat(paidRes.rows[0].total_paid as string);
      const outstandingAmount = parseFloat((order.total - totalAlreadyPaid).toFixed(2));

      if (outstandingAmount > 0.01) {
        // Check idempotency — only insert if no receivable already exists
        const existsRes = await client.query(
          "SELECT 1 FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1 LIMIT 1",
          [orderId],
        );
        if (!existsRes.rows.length) {
          await createReceivable(
            {
              sourceType: 'order_credit_sale',
              sourceRefId: order.orderNumber,
              sourceEntityId: Number(orderId),
              customerId: order.customerId,
              branchId: order.branchId,
              originalAmount: outstandingAmount,
              dueDate: dueDate ?? null,
            },
            client,
          );
        }
      }
    }

    await client.query('COMMIT');
    return getById(orderId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

export async function pay(orderId: string | number, staffCtx: StaffCtx): Promise<OrderRow> {
  const order = await getById(orderId);
  if (!['CONFIRMED', 'Confirmed', 'In_Progress'].includes(order.status)) throw new BusinessError('INVALID_STATE', "Cannot pay order in status '" + order.status + "'");
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const paidStatus = await dbStatus('PAID');
    await client.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [paidStatus, orderId]);
    await client.query('INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,\'UPDATE\',\'order\',$3,$4,$5)', [staffCtx.staffId, staffCtx.role, String(orderId), staffCtx.branchId, JSON.stringify({ action: 'pay', fromStatus: 'CONFIRMED', toStatus: 'PAID' })]);
    await insertOutbox(client, 'order.paid', { orderId: String(orderId), orderNumber: order.orderNumber, branchId: staffCtx.branchId });
    await client.query('COMMIT');
    return getById(orderId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

export async function progress(orderId: string | number, staffCtx: StaffCtx): Promise<OrderRow> {
  const order = await getById(orderId);
  if (order.status !== 'Confirmed') throw new BusinessError('INVALID_STATE', "Cannot progress order in status '" + order.status + "'");
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE orders SET status = 'In_Progress', updated_at = now() WHERE id = $1", [orderId]);
    await client.query('INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,\'UPDATE\',\'order\',$3,$4,$5)', [staffCtx.staffId, staffCtx.role, String(orderId), staffCtx.branchId, JSON.stringify({ action: 'progress' })]);
    await insertOutbox(client, 'order.in_progress', { orderId: String(orderId), orderNumber: order.orderNumber, branchId: staffCtx.branchId });
    await client.query('COMMIT');
    return getById(orderId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

export async function fulfill(orderId: string | number, staffCtx: StaffCtx): Promise<OrderRow> {
  const order = await getById(orderId);
  const ns = normaliseStatus(order.status);

  // ── Business rule: fulfillment is a logistics event, not a payment event ────
  // Fix C1: remove the cash_sale && !effectivelyPaid gate. Fulfillment is
  // allowed for any order in CONFIRMED, PARTIALLY_PAID, or PAID status,
  // regardless of sale_type or paymentStatus.
  // - CASH orders: payment_status is already 'paid' at confirmation, so
  //   the old gate was redundant. Removing it allows manual fulfillment in
  //   the rare case auto-fulfill in payments.service didn't run.
  // - CREDIT orders: payment follows delivery; fulfill must not be blocked
  //   by outstanding balance.
  // - PARTIALLY_PAID orders: explicitly allowed (bug condition C1 fix).
  if (!['CONFIRMED', 'PARTIALLY_PAID', 'PAID', 'Confirmed', 'In_Progress'].includes(order.status) && ns !== 'CONFIRMED') {
    throw new BusinessError('INVALID_STATE', `Cannot fulfill order in status '${order.status}'`);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');

    const locationId = await resolveLocationId(client, order, staffCtx);

    // ── Task 5.1: Replace stockOut() with fulfillReservation() ───────────────
    // Stock was already deducted at confirm() via stockOut(). Calling stockOut()
    // here again was a double-deduction (bug condition C1). fulfillReservation()
    // writes the audit trail and transitions reservations to 'deducted' without
    // modifying inventory.quantity.
    const lineItemsForReservation = (order.lineItems ?? [])
      .filter(item => item.qtyReserved > 0)
      .map(item => ({ bookId: item.bookId, qtyReserved: item.qtyReserved }));

    if (lineItemsForReservation.length > 0) {
      await invTxSvc.fulfillReservation(
        {
          orderId,
          locationId,
          lineItems: lineItemsForReservation,
          staffCtx,
        },
        client,
      );
    }

    // Move qty_reserved → qty_fulfilled, clear reservation counter on each line.
    for (const item of order.lineItems ?? []) {
      if (item.qtyReserved === 0) continue;
      await client.query(
        'UPDATE order_line_items SET qty_fulfilled = qty_fulfilled + $1, qty_reserved = 0 WHERE id = $2',
        [item.qtyReserved, item.id],
      );
    }

    // ── Task 5.3: Direct UPDATE inventory_reservations removed ───────────────
    // Reservation status transition ('reserved' → 'deducted') is now handled
    // entirely inside fulfillReservation() above.

    const fulfilledStatus = await dbStatus('FULFILLED');
    await client.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [fulfilledStatus, orderId]);
    await client.query(
      "INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'UPDATE','order',$3,$4,$5)",
      [staffCtx.staffId, staffCtx.role, String(orderId), staffCtx.branchId,
       JSON.stringify({ action: 'fulfill', fromStatus: order.status, toStatus: 'FULFILLED', saleType: order.saleType })],
    );
    await insertOutbox(client, 'order.fulfilled', { orderId: String(orderId), orderNumber: order.orderNumber, branchId: staffCtx.branchId });

    // ── Task 5.4: Auto-transition to COMPLETED (preserved for both sale types) ─
    // Both CASH and CREDIT orders transition to COMPLETED at fulfillment.
    // For credit_sale the receivable stays open until paid — COMPLETED is
    // the operational close state, not the financial close state.
    // Task 5.5: No receivable settlement here — receivables are settled only
    // by payments.service.createPayment().
    const completedStatus = await dbStatus('COMPLETED');
    await client.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [completedStatus, orderId]);
    await insertOutbox(client, 'order.completed', { orderId: String(orderId), orderNumber: order.orderNumber, branchId: staffCtx.branchId });

    await client.query('COMMIT');
    return getById(orderId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

export async function cancel(orderId: string | number, reason: string, staffCtx: StaffCtx): Promise<OrderRow> {
  const order = await getById(orderId);
  const ns = normaliseStatus(order.status);

  // ── Block cancellation of post-fulfillment states ─────────────────────────
  if (['FULFILLED', 'COMPLETED'].includes(ns)) {
    throw new BusinessError('ORDER_ALREADY_FULFILLED', 'Cannot cancel a fulfilled or completed order. Use the Return module for post-fulfillment reversals.');
  }
  if (ns === 'CANCELLED') throw new BusinessError('ALREADY_CANCELLED', 'Order is already cancelled');

  // Fix 9.4: hasDeductedStock is the sole gate — stockOut ran at confirm() time
  // for all CONFIRMED/PARTIALLY_PAID/PAID orders. No need to query inventory_history.
  const hasDeductedStock = ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'].includes(ns);

  const client = await db.connect();
  try {
    // Task 6.3: Fully atomic — all three steps (stockIn, reservation release,
    // receivable settle) are inside ONE transaction. Any failure rolls everything back.
    await client.query('BEGIN');

    if (hasDeductedStock) {
      // Fix 9.4: Resolve locationId using the same helper as confirm() and fulfill()
      const locationId = await resolveLocationId(client, order, staffCtx);

      // Restore inventory.quantity for each line item that had reserved stock.
      // This must happen inside the transaction, before the receivable step.
      for (const item of order.lineItems ?? []) {
        if (item.qtyReserved <= 0) continue;
        await invTxSvc.stockIn(
          {
            bookId: item.bookId,
            locationId,
            quantity: item.qtyReserved,
            referenceType: 'order_cancelled',
            referenceId: orderId,
            reasonCode: 'return',
            notes: `Order cancellation – order ${String(orderId)}`,
            staffCtx,
          },
          client,
        );
      }
    }

    if (hasDeductedStock) {
      // Always release soft reservations for CONFIRMED/PARTIALLY_PAID/PAID orders
      try {
        await client.query(
          "UPDATE inventory_reservations SET status = 'released', updated_at = now() WHERE order_id = $1 AND status = 'reserved'",
          [orderId],
        );
      } catch (invResErr) {
        const msg = (invResErr as { message?: string }).message ?? '';
        if (!msg.toLowerCase().includes('inventory_reservations')) throw invResErr;
      }
    }

    // Zero out qty_reserved on all line items.
    for (const item of order.lineItems ?? []) {
      if (item.qtyReserved > 0) {
        await client.query('UPDATE order_line_items SET qty_reserved = 0 WHERE id = $1', [item.id]);
      }
    }

    // ── Settle any open order_credit_sale receivable ───────────────────────────
    // Task 6.3: Hard failure — if receivable settlement fails the whole transaction
    // rolls back. The savepoint that swallowed errors is removed.
    //
    // Bug fix: this MUST run before the order's own status flips to CANCELLED
    // below. updateReceivableOnPayment() has its own defensive guard ("Bug 4")
    // that silently no-ops if the linked order is already CANCELLED -- that
    // guard exists to stop some OTHER caller (e.g. createPayment) from
    // reactivating a receivable after the fact, but it can't distinguish that
    // from cancel() itself trying to close the receivable out as part of the
    // cancellation. Calling it after the UPDATE below meant this guard fired
    // on cancel()'s own settlement attempt every time, unconditionally --
    // receivables for cancelled credit orders never actually settled, leaving
    // the phantom-debt state order-payment-unification (3.5, 4.3) says this
    // is supposed to prevent.
    const recRes = await client.query(
      "SELECT 1 FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1 AND status != 'Settled' LIMIT 1",
      [orderId],
    );
    if (recRes.rows.length) {
      await updateReceivableOnPayment(
        {
          sourceType: 'order_credit_sale',
          sourceEntityId: Number(orderId),
          newOutstandingAmount: 0,
          isFullySettled: true,
        },
        client,
      );
    }

    const cancelledStatus = await dbStatus('CANCELLED');
    await client.query('UPDATE orders SET status = $1, cancel_reason = $2, updated_at = now() WHERE id = $3', [cancelledStatus, reason, orderId]);
    await client.query(
      "INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'UPDATE','order',$3,$4,$5)",
      [staffCtx.staffId, staffCtx.role, String(orderId), staffCtx.branchId,
       JSON.stringify({ action: 'cancel', fromStatus: order.status, toStatus: 'CANCELLED', reason, financialLifecycleFrozen: true, note: 'Payment collection disabled. Receivable voided. No further financial transactions allowed.' })],
    );
    await insertOutbox(client, 'order.cancelled', { orderId: String(orderId), orderNumber: order.orderNumber, branchId: staffCtx.branchId, reason });

    await client.query('COMMIT');
    return getById(orderId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

export async function updatePaymentStatus(orderId: string | number, paymentStatus: 'unpaid' | 'partial' | 'paid' | 'refunded'): Promise<void> {
  await db.query('UPDATE orders SET payment_status = $1, updated_at = now() WHERE id = $2', [paymentStatus, orderId]);
}

// ── deleteOrder (Module 9 — admin-only cleanup for Draft/Cancelled orders) ────
//
// Only DRAFT (never confirmed) or CANCELLED orders are eligible — anything
// further along the lifecycle must be cancelled first, not deleted, so its
// history survives. Even within those two statuses, deletion is blocked if
// any financial or inventory record still references the order: a DRAFT
// order cancelled without ever being confirmed has none of these (confirm()
// is the only place stock gets deducted or a receivable created), but a
// CONFIRMED-then-CANCELLED order can have real history (payments collected
// before cancellation, a settled receivable, linked exchanges, inventory
// movement) that must be retained, not silently destroyed. order_line_items
// and inventory_reservations are ON DELETE CASCADE and clean up
// automatically; everything else is checked explicitly since
// receivables.source_entity_id is a polymorphic reference with no FK.
export async function deleteOrder(orderId: string | number, staffCtx: StaffCtx): Promise<void> {
  const order = await getById(orderId);
  const status = normaliseStatus(order.status);
  if (status !== 'DRAFT' && status !== 'CANCELLED') {
    throw new BusinessError(
      'INVALID_STATE',
      `Cannot delete order in status '${order.status}'. Only Draft or Cancelled orders can be deleted — cancel it first.`,
    );
  }

  const [payRes, recRes, instRes, exchRes, histRes] = await Promise.all([
    db.query('SELECT 1 FROM order_payments WHERE order_id = $1 LIMIT 1', [orderId]),
    db.query(
      "SELECT 1 FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1 LIMIT 1",
      [orderId],
    ),
    db.query('SELECT 1 FROM installment_plans WHERE order_id = $1 LIMIT 1', [orderId]),
    db.query('SELECT 1 FROM exchanges WHERE original_order_id = $1 LIMIT 1', [orderId]),
    db.query(
      "SELECT 1 FROM inventory_history WHERE reference_type IN ('order_confirmed','order_cancelled') AND reference_id = $1 LIMIT 1",
      [String(orderId)],
    ),
  ]);
  const blockers: string[] = [];
  if (payRes.rows.length) blockers.push('payments');
  if (recRes.rows.length) blockers.push('a receivable');
  if (instRes.rows.length) blockers.push('an installment plan');
  if (exchRes.rows.length) blockers.push('a linked exchange');
  if (histRes.rows.length) blockers.push('inventory movement history');
  if (blockers.length) {
    throw new BusinessError(
      'ORDER_HAS_DEPENDENCIES',
      `Cannot delete order ${order.orderNumber}: it has ${blockers.join(', ')} on record. Orders with financial or inventory history must be retained.`,
      { blockers },
    );
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM orders WHERE id = $1', [orderId]);
    await client.query(
      "INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'DELETE','order',$3,$4,$5)",
      [staffCtx.staffId, staffCtx.role, String(orderId), staffCtx.branchId,
       JSON.stringify({ orderNumber: order.orderNumber, status: order.status })],
    );
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

/**
 * Collects (partial or full) payment against a FULFILLED or COMPLETED credit order.
 * Reduces the receivable outstanding_amount; sets payment_status accordingly.
 *
 * Requirements: 2.13, 3.3
 */
export async function collectPayment(
  orderId: string | number,
  paymentAmount: number,
  staffCtx: StaffCtx,
): Promise<OrderRow> {
  if (paymentAmount <= 0) throw new ValidationError('paymentAmount must be positive');

  const order = await getById(orderId);
  const ns = normaliseStatus(order.status);

  // Bug 4: Cancelled orders have frozen financial lifecycle — no payment collection allowed
  if (ns === 'CANCELLED') {
    throw new BusinessError('ORDER_CANCELLED', 'Cannot collect payment on a cancelled order. Financial lifecycle is frozen.');
  }

  if (!['FULFILLED', 'COMPLETED'].includes(ns)) {
    throw new BusinessError('INVALID_STATE', `Cannot collect payment for order in status '${order.status}'. Order must be FULFILLED or COMPLETED.`);
  }
  if (order.saleType !== 'credit_sale') {
    throw new BusinessError('INVALID_STATE', 'collectPayment is only valid for credit_sale orders');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the receivable row for update
    const recRes = await client.query(
      `SELECT outstanding_amount FROM receivables
       WHERE source_type = 'order_credit_sale' AND source_entity_id = $1
       FOR UPDATE`,
      [Number(orderId)],
    );
    if (!recRes.rows.length) {
      throw new BusinessError('RECEIVABLE_NOT_FOUND', `No receivable found for order ${String(orderId)}`);
    }

    const currentOutstanding = parseFloat(recRes.rows[0].outstanding_amount as string);
    const newOutstanding = Math.max(0, currentOutstanding - paymentAmount);
    const isFullySettled = newOutstanding === 0;

    await updateReceivableOnPayment(
      {
        sourceType: 'order_credit_sale',
        sourceEntityId: Number(orderId),
        newOutstandingAmount: newOutstanding,
        isFullySettled,
      },
      client,
    );

    const newPaymentStatus = isFullySettled ? 'paid' : 'partially_paid';
    await client.query(
      'UPDATE orders SET payment_status = $1, updated_at = now() WHERE id = $2',
      [newPaymentStatus, orderId],
    );

    await client.query(
      "INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'UPDATE','order',$3,$4,$5)",
      [
        staffCtx.staffId,
        staffCtx.role,
        String(orderId),
        staffCtx.branchId,
        JSON.stringify({
          action: 'collect_payment',
          paymentAmount,
          previousOutstanding: currentOutstanding,
          newOutstanding,
          isFullySettled,
        }),
      ],
    );

    await client.query('COMMIT');
    return getById(orderId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

/**
 * Computes the list of allowed actions for an order based on its current status,
 * sale type, and the permissions of the requesting staff member.
 *
 * Legacy Code Audit note: `paymentStatus`/`saleType` are accepted (and every
 * call site — orders.routes.ts and the lifecycle test suites — still passes
 * them) but no branch below currently reads either one; the old
 * payment-status-gated 'pay' action was removed as part of the Task 7.x
 * lifecycle-state-machine refactor once payment collection moved fully to
 * the Payments module. Left in the signature rather than removed: dropping
 * them would require touching every call site and the many lifecycle tests
 * that assert against this exact 4-arg signature, for a purely cosmetic
 * change — out of proportion for a "safe" cleanup pass. Underscore-prefixed
 * to satisfy noUnusedParameters without altering behavior.
 */
export function computeOrderAllowedActions(
  status: string,
  permissions: Permission[],
  _paymentStatus?: string,
  _saleType?: 'cash_sale' | 'credit_sale',
): string[] {
  const can = (p: Permission) => permissions.includes(p);

  switch (status) {
    case 'DRAFT':
      return [...(can('CREATE_SALE') ? ['confirm', 'cancel'] : [])];

    case 'CONFIRMED':
      // Task 7.2: Remove the payment-status gate. Fulfillment is a logistics
      // event — both CASH and CREDIT confirmed orders are fulfillable regardless
      // of paymentStatus or saleType. The old isCreditSale && paymentStatus='paid'
      // split was bug condition C1.
      return [
        ...(can('CREATE_SALE') ? ['cancel'] : []),
        ...(can('PROCESS_PAYMENT') ? ['fulfill'] : []),
      ];

    // Task 7.1: Add PARTIALLY_PAID branch.
    // Previously fell through to default: [] — that was bug condition C1.
    // PARTIALLY_PAID orders can be cancelled or fulfilled.
    case 'PARTIALLY_PAID':
      return [
        ...(can('CREATE_SALE') ? ['cancel'] : []),
        ...(can('PROCESS_PAYMENT') ? ['fulfill'] : []),
      ];

    case 'PAID':
      return [...(can('PROCESS_PAYMENT') ? ['fulfill'] : [])];

    // Task 7.3: FULFILLED returns ['return'] — preserved unchanged.
    // No cancel, no pay, no fulfill for already-fulfilled orders.
    case 'FULFILLED':
      return ['return'];

    case 'COMPLETED':
      return ['print'];

    case 'CANCELLED':
      return [];

    // Legacy status values
    case 'Pending':
      return [...(can('CREATE_SALE') ? ['confirm', 'cancel'] : [])];

    case 'Confirmed':
    case 'In_Progress':
      // Task 7.2 (legacy path): remove payment-status gate here too
      return [
        ...(can('CREATE_SALE') ? ['cancel'] : []),
        ...(can('PROCESS_PAYMENT') ? ['fulfill'] : []),
      ];

    case 'Fulfilled':
      return ['print'];

    case 'Cancelled':
      return [];

    default:
      return [];
  }
}
