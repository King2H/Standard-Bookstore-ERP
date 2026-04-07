import { db } from '../../db/index.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import type { PoolClient } from 'pg';

export interface StaffCtx { staffId: number; role: string; branchId: number; }

export type PaymentMethod = 'cash' | 'bank' | 'mobile' | 'card' | 'store_credit' | 'loyalty_points' | 'other';
export type PaymentStatus = 'pending' | 'success' | 'failed' | 'refunded' | 'partially_refunded';

export interface PaymentRow {
  id: string;
  paymentReference: string;
  orderId: string;
  amount: number;
  currency: string;
  paymentMethod: PaymentMethod;
  status: PaymentStatus;
  transactionReference: string | null;
  notes: string | null;
  processedBy: number;
  processedAt: string;
  createdAt: string;
  refunds?: RefundRow[];
}

export interface RefundRow {
  id: string;
  paymentId: string;
  orderId: string;
  refundAmount: number;
  reason: string;
  processedBy: number;
  createdAt: string;
}

function mapPaymentRow(row: Record<string, unknown>): PaymentRow {
  return {
    id: String(row.id),
    paymentReference: row.payment_reference as string,
    orderId: String(row.order_id),
    amount: parseFloat(row.amount as string),
    currency: row.currency as string,
    paymentMethod: row.payment_method as PaymentMethod,
    status: row.status as PaymentStatus,
    transactionReference: (row.transaction_reference as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    processedBy: row.processed_by as number,
    processedAt: (row.processed_at as Date).toISOString(),
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function mapRefundRow(row: Record<string, unknown>): RefundRow {
  return {
    id: String(row.id),
    paymentId: String(row.payment_id),
    orderId: String(row.order_id),
    refundAmount: parseFloat(row.refund_amount as string),
    reason: row.reason as string,
    processedBy: row.processed_by as number,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

// ── Compute order payment_status from payments ────────────────────────────────

async function computeOrderPaymentStatus(
  client: PoolClient,
  orderId: string | number,
): Promise<'unpaid' | 'partial' | 'paid' | 'refunded'> {
  const orderRes = await client.query('SELECT total FROM orders WHERE id = $1', [orderId]);
  if (!orderRes.rows.length) throw new NotFoundError('Order');
  const orderTotal = parseFloat(orderRes.rows[0].total as string);

  const paidRes = await client.query(
    "SELECT COALESCE(SUM(amount), 0) AS total_paid FROM order_payments WHERE order_id = $1 AND status IN ('success','partially_refunded','refunded')",
    [orderId],
  );
  const totalPaid = parseFloat(paidRes.rows[0].total_paid as string);

  const refundRes = await client.query(
    'SELECT COALESCE(SUM(refund_amount), 0) AS total_refunded FROM order_refunds WHERE order_id = $1',
    [orderId],
  );
  const totalRefunded = parseFloat(refundRes.rows[0].total_refunded as string);

  const netPaid = parseFloat((totalPaid - totalRefunded).toFixed(2));

  if (totalRefunded >= totalPaid && totalPaid > 0) return 'refunded';
  if (netPaid <= 0) return 'unpaid';
  if (netPaid >= orderTotal - 0.01) return 'paid';
  return 'partial';
}

// ── getById ───────────────────────────────────────────────────────────────────

export async function getById(id: string | number): Promise<PaymentRow> {
  const res = await db.query('SELECT * FROM order_payments WHERE id = $1', [id]);
  if (!res.rows.length) throw new NotFoundError('Payment');
  const payment = mapPaymentRow(res.rows[0]);
  const refundRes = await db.query('SELECT * FROM order_refunds WHERE payment_id = $1 ORDER BY id', [id]);
  payment.refunds = refundRes.rows.map(mapRefundRow);
  return payment;
}

// ── list ──────────────────────────────────────────────────────────────────────

export async function list(opts: {
  orderId?: number;
  status?: string;
  paymentMethod?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ items: PaymentRow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset = (page - 1) * pageSize;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.orderId)       { params.push(opts.orderId);       conditions.push('p.order_id = $' + params.length); }
  if (opts.status)        { params.push(opts.status);        conditions.push('p.status = $' + params.length); }
  if (opts.paymentMethod) { params.push(opts.paymentMethod); conditions.push('p.payment_method = $' + params.length); }
  if (opts.dateFrom)      { params.push(opts.dateFrom);      conditions.push('p.created_at >= $' + params.length); }
  if (opts.dateTo)        { params.push(opts.dateTo);        conditions.push('p.created_at <= $' + params.length); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const li = params.length + 1;
  const oi = params.length + 2;

  const [countRes, dataRes] = await Promise.all([
    db.query('SELECT COUNT(*) FROM order_payments p ' + where, params),
    db.query('SELECT p.* FROM order_payments p ' + where + ' ORDER BY p.created_at DESC LIMIT $' + li + ' OFFSET $' + oi, [...params, pageSize, offset]),
  ]);

  return {
    items: dataRes.rows.map(mapPaymentRow),
    total: parseInt(countRes.rows[0].count as string, 10),
    page,
    totalPages: Math.ceil(parseInt(countRes.rows[0].count as string, 10) / pageSize),
  };
}

// ── listByOrder ───────────────────────────────────────────────────────────────

export async function listByOrder(orderId: string | number): Promise<PaymentRow[]> {
  const res = await db.query('SELECT * FROM order_payments WHERE order_id = $1 ORDER BY created_at ASC', [orderId]);
  return res.rows.map(mapPaymentRow);
}

// ── createPayment ─────────────────────────────────────────────────────────────

export async function createPayment(
  data: {
    orderId: number;
    amount: number;
    paymentMethod: PaymentMethod;
    transactionReference?: string;
    notes?: string;
  },
  staffCtx: StaffCtx,
): Promise<PaymentRow> {
  if (data.amount <= 0) throw new ValidationError('Payment amount must be positive');

  // Validate order exists and is not cancelled
  const orderRes = await db.query('SELECT id, total, status, payment_status FROM orders WHERE id = $1', [data.orderId]);
  if (!orderRes.rows.length) throw new NotFoundError('Order');
  const order = orderRes.rows[0] as Record<string, unknown>;
  if (order.status === 'Cancelled') throw new BusinessError('ORDER_CANCELLED', 'Cannot record payment on a cancelled order');

  // Check payment would not exceed order total
  const existingRes = await db.query(
    "SELECT COALESCE(SUM(amount), 0) AS total_paid FROM order_payments WHERE order_id = $1 AND status IN ('success','partially_refunded')",
    [data.orderId],
  );
  const alreadyPaid = parseFloat(existingRes.rows[0].total_paid as string);
  const orderTotal = parseFloat(order.total as string);
  if (alreadyPaid + data.amount > orderTotal + 0.01) {
    throw new BusinessError('EXCEEDS_ORDER_TOTAL',
      `Payment of ETB ${data.amount} would exceed order total ETB ${orderTotal}. Already paid: ETB ${alreadyPaid}`,
      { orderTotal, alreadyPaid, requested: data.amount, outstanding: parseFloat((orderTotal - alreadyPaid).toFixed(2)) });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Generate payment reference
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cntRes = await client.query('SELECT COUNT(*) FROM order_payments WHERE DATE(created_at) = CURRENT_DATE');
    const paymentReference = 'PAY-' + dateStr + '-' + String(parseInt(cntRes.rows[0].count as string, 10) + 1).padStart(4, '0');

    const payRes = await client.query(
      "INSERT INTO order_payments (payment_reference, order_id, amount, currency, payment_method, status, transaction_reference, notes, processed_by) VALUES ($1,$2,$3,'ETB',$4,'success',$5,$6,$7) RETURNING id",
      [paymentReference, data.orderId, data.amount.toFixed(2), data.paymentMethod, data.transactionReference ?? null, data.notes ?? null, staffCtx.staffId],
    );
    const paymentId = String(payRes.rows[0].id);

    // Recompute and update order payment_status
    const newPaymentStatus = await computeOrderPaymentStatus(client, data.orderId);
    await client.query('UPDATE orders SET payment_status = $1, updated_at = now() WHERE id = $2', [newPaymentStatus, data.orderId]);

    await client.query(
      "INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'CREATE','payment',$3,$4,$5)",
      [staffCtx.staffId, staffCtx.role, paymentId, staffCtx.branchId,
       JSON.stringify({ paymentReference, orderId: data.orderId, amount: data.amount, paymentMethod: data.paymentMethod, newPaymentStatus })],
    );

    await client.query('COMMIT');
    return getById(paymentId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

// ── createRefund ──────────────────────────────────────────────────────────────

export async function createRefund(
  paymentId: string | number,
  data: { refundAmount: number; reason: string },
  staffCtx: StaffCtx,
): Promise<RefundRow> {
  if (data.refundAmount <= 0) throw new ValidationError('Refund amount must be positive');

  const payment = await getById(paymentId);
  if (payment.status === 'failed') throw new BusinessError('PAYMENT_FAILED', 'Cannot refund a failed payment');

  // Check refund does not exceed payment amount
  const existingRefundRes = await db.query(
    'SELECT COALESCE(SUM(refund_amount), 0) AS total_refunded FROM order_refunds WHERE payment_id = $1',
    [paymentId],
  );
  const alreadyRefunded = parseFloat(existingRefundRes.rows[0].total_refunded as string);
  if (alreadyRefunded + data.refundAmount > payment.amount + 0.01) {
    throw new BusinessError('EXCEEDS_PAYMENT_AMOUNT',
      `Refund of ETB ${data.refundAmount} would exceed payment amount ETB ${payment.amount}. Already refunded: ETB ${alreadyRefunded}`,
      { paymentAmount: payment.amount, alreadyRefunded, requested: data.refundAmount });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const refundRes = await client.query(
      'INSERT INTO order_refunds (payment_id, order_id, refund_amount, reason, processed_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [paymentId, payment.orderId, data.refundAmount.toFixed(2), data.reason, staffCtx.staffId],
    );
    const refundId = String(refundRes.rows[0].id);

    // Update payment status
    const newAlreadyRefunded = alreadyRefunded + data.refundAmount;
    const newPaymentStatus: PaymentStatus = newAlreadyRefunded >= payment.amount - 0.01 ? 'refunded' : 'partially_refunded';
    await client.query('UPDATE order_payments SET status = $1 WHERE id = $2', [newPaymentStatus, paymentId]);

    // Recompute and update order payment_status
    const newOrderPaymentStatus = await computeOrderPaymentStatus(client, payment.orderId);
    await client.query('UPDATE orders SET payment_status = $1, updated_at = now() WHERE id = $2', [newOrderPaymentStatus, payment.orderId]);

    await client.query(
      "INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'CREATE','payment_refund',$3,$4,$5)",
      [staffCtx.staffId, staffCtx.role, refundId, staffCtx.branchId,
       JSON.stringify({ paymentId, orderId: payment.orderId, refundAmount: data.refundAmount, reason: data.reason, newPaymentStatus, newOrderPaymentStatus })],
    );

    await client.query('COMMIT');

    const row = await db.query('SELECT * FROM order_refunds WHERE id = $1', [refundId]);
    return mapRefundRow(row.rows[0]);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

// ── getOrderBalance ───────────────────────────────────────────────────────────

export async function getOrderBalance(orderId: string | number): Promise<{
  orderTotal: number;
  totalPaid: number;
  totalRefunded: number;
  outstanding: number;
  paymentStatus: string;
}> {
  const orderRes = await db.query('SELECT total, payment_status FROM orders WHERE id = $1', [orderId]);
  if (!orderRes.rows.length) throw new NotFoundError('Order');
  const orderTotal = parseFloat(orderRes.rows[0].total as string);
  const paymentStatus = orderRes.rows[0].payment_status as string;

  const paidRes = await db.query(
    "SELECT COALESCE(SUM(amount), 0) AS total_paid FROM order_payments WHERE order_id = $1 AND status IN ('success','partially_refunded','refunded')",
    [orderId],
  );
  const totalPaid = parseFloat(paidRes.rows[0].total_paid as string);

  const refundRes = await db.query(
    'SELECT COALESCE(SUM(refund_amount), 0) AS total_refunded FROM order_refunds WHERE order_id = $1',
    [orderId],
  );
  const totalRefunded = parseFloat(refundRes.rows[0].total_refunded as string);
  const outstanding = parseFloat((orderTotal - totalPaid + totalRefunded).toFixed(2));

  return { orderTotal, totalPaid, totalRefunded, outstanding: Math.max(0, outstanding), paymentStatus };
}
