import { db } from '../../db/index.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import type { PoolClient } from 'pg';
import { insertOutbox } from '../../lib/outbox.js';
import { updateReceivableOnPayment } from '../receivables/receivables.service.js';

export interface StaffCtx { staffId: number; role: string; branchId: number; }

export type PaymentMethod = 'cash' | 'bank' | 'mobile' | 'card' | 'store_credit' | 'loyalty_points' | 'other';
export type PaymentStatus = 'pending' | 'success' | 'failed' | 'refunded' | 'partially_refunded';

export interface PaymentRow {
  id: string;
  paymentReference: string;
  orderId: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  status: PaymentStatus;
  transactionReference: string | null;
  notes: string | null;
  processedAt: string;
  createdAt: string;
  processedBy: number;
  bankAccountId: number | null;
  refunds?: RefundRow[];
  sourceType?: string;
  entityNumber?: string;
  /** Status of the associated order — used by frontend to hide Refund on FULFILLED orders */
  orderStatus?: string;
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
    orderId: String(row.order_id ?? row.entity_id),
    amount: parseFloat(row.amount as string),
    currency: row.currency as string,
    paymentMethod: row.payment_method as PaymentMethod,
    status: row.status as PaymentStatus,
    transactionReference: (row.transaction_reference as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    bankAccountId: (row.bank_account_id as number | null) ?? null,
    processedBy: row.processed_by as number,
    processedAt: (row.processed_at as Date).toISOString(),
    createdAt: (row.created_at as Date).toISOString(),
    sourceType: row.source_type as string | undefined,
    entityNumber: row.entity_number as string | undefined,
    orderStatus: row.order_status as string | undefined,
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
  const rawTotal = orderRes.rows[0].total;
  if (rawTotal == null) throw new BusinessError('ORDER_INVALID', 'Order has no total amount. Ensure the order was created correctly.');
  const orderTotal = parseFloat(rawTotal as string);
  if (isNaN(orderTotal) || orderTotal < 0) throw new BusinessError('ORDER_INVALID', 'Order total is invalid.');

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

  if (opts.orderId)       { params.push(opts.orderId);       conditions.push('u.order_id = $' + params.length); }
  if (opts.status)        { params.push(opts.status);        conditions.push('u.status = $' + params.length); }
  if (opts.paymentMethod) { params.push(opts.paymentMethod); conditions.push('u.payment_method = $' + params.length); }
  if (opts.dateFrom)      { params.push(opts.dateFrom);      conditions.push('u.created_at >= $' + params.length); }
  if (opts.dateTo)        { params.push(opts.dateTo);        conditions.push('u.created_at <= $' + params.length); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const li = params.length + 1;
  const oi = params.length + 2;

  const queryText = `
    WITH u AS (
      SELECT
        p.id::text AS id,
        p.payment_reference,
        p.order_id::text AS order_id,
        o.order_number AS entity_number,
        'order' AS source_type,
        p.amount,
        p.currency,
        p.payment_method,
        p.status,
        p.transaction_reference,
        p.notes,
        p.processed_at,
        p.created_at,
        p.processed_by,
        p.bank_account_id,
        o.status AS order_status
      FROM order_payments p
      JOIN orders o ON o.id = p.order_id
      UNION ALL
      SELECT
        tp.id::text AS id,
        COALESCE(tp.reference, 'PAY-POS-' || tp.id) AS payment_reference,
        t.id::text AS order_id,
        t.transaction_number AS entity_number,
        'pos' AS source_type,
        tp.amount,
        'ETB' AS currency,
        tp.method AS payment_method,
        'success' AS status,
        tp.reference AS transaction_reference,
        'POS Credit Sale Collection' AS notes,
        tp.created_at AS processed_at,
        tp.created_at,
        t.staff_id AS processed_by,
        NULL::integer AS bank_account_id,
        NULL::text AS order_status
      FROM transaction_payments tp
      JOIN transactions t ON t.id = tp.transaction_id
      JOIN receivables r ON r.source_type = 'pos_credit_sale' AND r.source_entity_id = t.id
    )
    SELECT * FROM u
    ${where}
    ORDER BY u.created_at DESC
    LIMIT $${li} OFFSET $${oi}
  `;

  const countQueryText = `
    WITH u AS (
      SELECT
        p.order_id::text AS order_id,
        p.status,
        p.payment_method,
        p.created_at
      FROM order_payments p
      UNION ALL
      SELECT
        t.id::text AS order_id,
        'success' AS status,
        tp.method AS payment_method,
        tp.created_at
      FROM transaction_payments tp
      JOIN transactions t ON t.id = tp.transaction_id
      JOIN receivables r ON r.source_type = 'pos_credit_sale' AND r.source_entity_id = t.id
    )
    SELECT COUNT(*) FROM u
    ${where}
  `;

  const [countRes, dataRes] = await Promise.all([
    db.query(countQueryText, params),
    db.query(queryText, [...params, pageSize, offset]),
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
    bankAccountId?: number | null;
  },
  staffCtx: StaffCtx,
): Promise<PaymentRow> {
  if (data.amount <= 0) throw new ValidationError('Payment amount must be positive');

  // Bank transfer requires bank_account_id
  if (data.paymentMethod === 'bank') {
    if (!data.bankAccountId) {
      throw new ValidationError('bank_account_id is required for bank transfer payments');
    }
    // Validate bank account belongs to this branch and is active
    const baRes = await db.query(
      'SELECT id, is_active, branch_id FROM bank_accounts WHERE id = $1',
      [data.bankAccountId],
    );
    if (!baRes.rows.length) throw new BusinessError('INVALID_BANK_ACCOUNT', 'Bank account not found');
    if (!baRes.rows[0].is_active) throw new BusinessError('INVALID_BANK_ACCOUNT', 'Bank account is inactive');
    if (baRes.rows[0].branch_id !== staffCtx.branchId) {
      throw new BusinessError('INVALID_BANK_ACCOUNT', 'Bank account does not belong to the current branch');
    }
  }

  // Validate order exists and is not cancelled
  const orderRes = await db.query('SELECT id, total, status, payment_status, customer_id, sale_type FROM orders WHERE id = $1', [data.orderId]);
  if (!orderRes.rows.length) throw new NotFoundError('Order');
  const order = orderRes.rows[0] as Record<string, unknown>;

  // Task 9.1: Block only genuinely cancelled orders. FULFILLED and COMPLETED
  // orders must NOT be blocked — credit_sale orders need post-fulfillment payment.
  // Handle both legacy ('Cancelled') and new ('CANCELLED') status values.
  const orderStatusNorm = String(order.status ?? '').toUpperCase();
  if (orderStatusNorm === 'CANCELLED') {
    throw new BusinessError('ORDER_CANCELLED', 'Cannot record payment on a cancelled order');
  }

  // Bug 2: Cash orders are always paid at confirmation — never accept a payment
  // collection attempt against them. This is a defensive guard; the unpaid-orders
  // list already excludes cash orders from the UI.
  if (String(order.sale_type ?? '') === 'cash_sale') {
    throw new BusinessError('CASH_ORDER_ALREADY_PAID', 'Cash orders are paid automatically at confirmation. Payment collection is only available for credit orders.');
  }

  if (order.total == null) throw new BusinessError('ORDER_INVALID', 'Order has no total. Ensure the order was created with valid book prices.');
  const customerId = (order.customer_id as number | null) ?? null;

  // Store credit / loyalty points requires a customer on the order. The
  // balance sufficiency itself is only fail-fast-checked here, on the plain
  // (unlocked) connection, for a quick error before doing the rest of this
  // function's work -- it is NOT the authoritative check. That check happens
  // again below, inside the transaction, with FOR UPDATE (Module 4 fix: this
  // pre-check used to be the ONLY check, and the deduction UPDATE below never
  // re-verified sufficiency or locked the row, so two concurrent payments
  // against the same balance could both pass, both deduct, and drive the
  // balance negative -- pos.service.ts recordPayment() and receivables.
  // service.ts collectPayment() already lock correctly; this was the one
  // gap in an otherwise-consistent pattern).
  if (data.paymentMethod === 'store_credit') {
    if (!customerId) {
      throw new BusinessError('STORE_CREDIT_REQUIRES_CUSTOMER', 'Store credit payments require the order to be linked to a customer.');
    }
    const scRes = await db.query('SELECT balance FROM store_credit_accounts WHERE customer_id = $1', [customerId]);
    if (!scRes.rows.length) {
      throw new BusinessError('INSUFFICIENT_STORE_CREDIT', 'Customer has no store credit account.');
    }
    const available = parseFloat(scRes.rows[0].balance as string);
    if (available < data.amount - 0.01) {
      throw new BusinessError('INSUFFICIENT_STORE_CREDIT',
        `Insufficient store credit. Available: ETB ${available.toFixed(2)}, requested: ETB ${data.amount.toFixed(2)}`,
        { available, requested: data.amount });
    }
  }

  // Loyalty points requires a customer on the order
  if (data.paymentMethod === 'loyalty_points') {
    if (!customerId) {
      throw new BusinessError('LOYALTY_REQUIRES_CUSTOMER', 'Loyalty point payments require the order to be linked to a customer.');
    }
    const lpRes = await db.query('SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1', [customerId]);
    if (!lpRes.rows.length) {
      throw new BusinessError('INSUFFICIENT_LOYALTY_POINTS', 'Customer has no loyalty account.');
    }
    const available = parseFloat(lpRes.rows[0].points_balance as string);
    if (available < data.amount - 0.01) {
      throw new BusinessError('INSUFFICIENT_LOYALTY_POINTS',
        `Insufficient loyalty points. Available: ${available.toFixed(0)} pts, requested: ${data.amount.toFixed(0)} pts`,
        { available, requested: data.amount });
    }
  }

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
      "INSERT INTO order_payments (payment_reference, order_id, amount, currency, payment_method, status, transaction_reference, notes, processed_by, bank_account_id) VALUES ($1,$2,$3,'ETB',$4,'success',$5,$6,$7,$8) RETURNING id",
      [paymentReference, data.orderId, data.amount.toFixed(2), data.paymentMethod, data.transactionReference ?? null, data.notes ?? null, staffCtx.staffId, data.bankAccountId ?? null],
    );
    const paymentId = String(payRes.rows[0].id);

    // Auto-create bank reconciliation entry for bank transfers
    if (data.paymentMethod === 'bank' && data.bankAccountId) {
      await client.query(
        `INSERT INTO bank_reconciliation (bank_account_id, payment_ref_id, amount, direction, status)
         VALUES ($1, $2, $3, 'in', 'uncleared')`,
        [data.bankAccountId, paymentId, data.amount.toFixed(2)],
      );
    }

    // Deduct store credit from customer account. Re-validate sufficiency here,
    // under FOR UPDATE, since the check above ran on an unlocked connection
    // before this transaction opened and cannot prevent two concurrent
    // payments from both passing and driving the balance negative.
    if (data.paymentMethod === 'store_credit' && customerId) {
      const scLockRes = await client.query(
        'SELECT balance FROM store_credit_accounts WHERE customer_id = $1 FOR UPDATE',
        [customerId],
      );
      const lockedAvailable = scLockRes.rows.length ? parseFloat(scLockRes.rows[0].balance as string) : 0;
      if (lockedAvailable < data.amount - 0.01) {
        throw new BusinessError('INSUFFICIENT_STORE_CREDIT',
          `Insufficient store credit. Available: ETB ${lockedAvailable.toFixed(2)}, requested: ETB ${data.amount.toFixed(2)}`,
          { available: lockedAvailable, requested: data.amount });
      }
      await client.query(
        'UPDATE store_credit_accounts SET balance = balance - $1 WHERE customer_id = $2',
        [data.amount.toFixed(2), customerId],
      );
      await client.query(
        `INSERT INTO store_credit_history (customer_id, ref_type, ref_id, amount, direction)
         VALUES ($1, 'order_payment', $2, $3, 'debit')`,
        [customerId, paymentId, data.amount.toFixed(2)],
      );
    }

    // Deduct loyalty points from customer account. Same re-validation under
    // FOR UPDATE as store credit above, for the same reason.
    if (data.paymentMethod === 'loyalty_points' && customerId) {
      const lpLockRes = await client.query(
        'SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1 FOR UPDATE',
        [customerId],
      );
      const lockedAvailable = lpLockRes.rows.length ? parseFloat(lpLockRes.rows[0].points_balance as string) : 0;
      if (lockedAvailable < data.amount - 0.01) {
        throw new BusinessError('INSUFFICIENT_LOYALTY_POINTS',
          `Insufficient loyalty points. Available: ${lockedAvailable.toFixed(0)} pts, requested: ${data.amount.toFixed(0)} pts`,
          { available: lockedAvailable, requested: data.amount });
      }
      await client.query(
        'UPDATE loyalty_accounts SET points_balance = points_balance - $1, updated_at = now() WHERE customer_id = $2',
        [data.amount.toFixed(2), customerId],
      );
      await client.query(
        `INSERT INTO loyalty_history (customer_id, transaction_ref, points_delta, reason)
         VALUES ($1, $2, $3, 'REDEMPTION')`,
        [customerId, paymentReference, -data.amount],
      );
    }

    // Recompute and update order payment_status
    const newPaymentStatus = await computeOrderPaymentStatus(client, data.orderId);
    await client.query('UPDATE orders SET payment_status = $1, updated_at = now() WHERE id = $2', [newPaymentStatus, data.orderId]);

    // ── Auto-fulfill cash_sale orders when fully paid and still CONFIRMED ──────
    // For cash_sale: confirm() only creates a reservation; the stock deduction
    // happens at fulfill(). When the full payment arrives via this module,
    // we auto-fulfill so the operator does not need a second manual step.
    // credit_sale is excluded — it may be fulfilled before payment (on credit).
    let autoFulfilled = false;
    if (newPaymentStatus === 'paid') {
      try {
        await client.query('SAVEPOINT before_auto_fulfill');
        const orderStatusRes = await client.query(
          'SELECT status, sale_type, location_id, branch_id FROM orders WHERE id = $1 FOR UPDATE',
          [data.orderId],
        );
        if (orderStatusRes.rows.length) {
          const currentStatus = orderStatusRes.rows[0].status as string;
          const saleType = orderStatusRes.rows[0].sale_type as string;
          const ns = (currentStatus === 'Pending' || currentStatus === 'Confirmed' || currentStatus === 'In_Progress')
            ? 'CONFIRMED' : currentStatus;

          if (saleType === 'cash_sale' && (ns === 'CONFIRMED' || ns === 'PAID')) {
            // Resolve location
            const orderLocationId = orderStatusRes.rows[0].location_id as number | null;
            const branchIdForLoc = orderStatusRes.rows[0].branch_id as number;
            let locationId: number;
            if (orderLocationId) {
              locationId = orderLocationId;
            } else {
              const defLoc = await client.query(
                'SELECT id FROM locations WHERE branch_id = $1 AND is_default_fulfillment = true LIMIT 1',
                [branchIdForLoc],
              );
              if (defLoc.rows.length) {
                locationId = defLoc.rows[0].id as number;
              } else {
                const anyLoc = await client.query(
                  'SELECT id FROM locations WHERE branch_id = $1 ORDER BY id LIMIT 1',
                  [branchIdForLoc],
                );
                locationId = anyLoc.rows.length ? anyLoc.rows[0].id as number : branchIdForLoc;
              }
            }

            // Load line items with reserved quantities
            const lineItemsRes = await client.query(
              'SELECT id, book_id, qty_reserved FROM order_line_items WHERE order_id = $1 AND qty_reserved > 0',
              [data.orderId],
            );

            for (const li of lineItemsRes.rows) {
              const qtyRes = li.qty_reserved as number;
              if (qtyRes <= 0) continue;

              // Deduct stock exactly once at fulfillment
              await (await import('../inventory/inventoryTransaction.service.js')).stockOut(
                {
                  bookId: li.book_id as number,
                  locationId,
                  quantity: qtyRes,
                  referenceType: 'order_fulfilled',
                  referenceId: data.orderId,
                  reasonCode: 'loss',
                  notes: `Auto-fulfill on full payment – order ${data.orderId}`,
                  staffCtx,
                },
                client,
              );

              await client.query(
                'UPDATE order_line_items SET qty_fulfilled = qty_fulfilled + $1, qty_reserved = 0 WHERE id = $2',
                [qtyRes, li.id],
              );
            }

            // Release/deduct reservations
            await client.query(
              "UPDATE inventory_reservations SET status = 'deducted', updated_at = now() WHERE order_id = $1 AND status = 'reserved'",
              [data.orderId],
            ).catch(() => { /* graceful if table absent */ });

            // Transition to COMPLETED
            const usesNew = await client.query(
              `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'orders' AND c.conname = 'orders_status_check'`,
            );
            const constraintDef: string = usesNew.rows[0]?.def ?? '';
            const completedStatus = constraintDef.includes("'DRAFT'") ? 'COMPLETED' : 'Fulfilled';
            await client.query(
              'UPDATE orders SET status = $1, updated_at = now() WHERE id = $2',
              [completedStatus, data.orderId],
            );

            await insertOutbox(client, 'order.fulfilled', { orderId: String(data.orderId), branchId: staffCtx.branchId });
            await insertOutbox(client, 'order.completed', { orderId: String(data.orderId), branchId: staffCtx.branchId });
            autoFulfilled = true;
          }
        }
        await client.query('RELEASE SAVEPOINT before_auto_fulfill');
      } catch (fulfillErr) {
        await client.query('ROLLBACK TO SAVEPOINT before_auto_fulfill');
        console.error('payments.createPayment: auto-fulfill failed (non-fatal)', fulfillErr);
      }
    }
    void autoFulfilled; // suppress unused warning

    // ── Sync order_credit_sale receivable — MANDATORY, inside main transaction ──
    // Bug 5 fix: receivable update is NO LONGER wrapped in a savepoint.
    // It runs inside the main BEGIN/COMMIT block so a failure rolls back everything.
    // This guarantees the receivable and payment_status are always consistent.
    {
      const recRes = await client.query(
        "SELECT 1 FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1 AND status != 'Settled' LIMIT 1",
        [data.orderId],
      );
      if (recRes.rows.length) {
        const orderTotalRes = await client.query('SELECT total FROM orders WHERE id = $1', [data.orderId]);
        const orderTotalVal = parseFloat(orderTotalRes.rows[0].total as string);
        const paidRes2 = await client.query(
          "SELECT COALESCE(SUM(amount),0) AS total_paid FROM order_payments WHERE order_id = $1 AND status IN ('success','partially_refunded','refunded')",
          [data.orderId],
        );
        const totalPaidVal = parseFloat(paidRes2.rows[0].total_paid as string);
        const newOutstanding = Math.max(0, parseFloat((orderTotalVal - totalPaidVal).toFixed(2)));
        await updateReceivableOnPayment(
          {
            sourceType: 'order_credit_sale',
            sourceEntityId: Number(data.orderId),
            newOutstandingAmount: newOutstanding,
            isFullySettled: newPaymentStatus === 'paid',
          },
          client,
        );
      }
    }

    await client.query(
      "INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'CREATE','payment',$3,$4,$5)",
      [staffCtx.staffId, staffCtx.role, paymentId, staffCtx.branchId,
       JSON.stringify({ paymentReference, orderId: data.orderId, amount: data.amount, paymentMethod: data.paymentMethod, newPaymentStatus })],
    );

    // Emit payment notification
    const orderNumRes = await client.query('SELECT order_number FROM orders WHERE id = $1', [data.orderId]);
    const orderNumber = orderNumRes.rows[0]?.order_number ?? String(data.orderId);
    await insertOutbox(client, 'payment.recorded', {
      paymentId, amount: data.amount, method: data.paymentMethod, orderNumber, orderId: String(data.orderId), branchId: staffCtx.branchId,
    });
    if (data.paymentMethod === 'bank') {
      await insertOutbox(client, 'payment.bank_transfer', {
        paymentId, amount: data.amount, orderNumber, orderId: String(data.orderId), branchId: staffCtx.branchId,
      });
    }

    await client.query('COMMIT');
    return getById(paymentId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

// ── createRefund ──────────────────────────────────────────────────────────────

export async function createRefund(
  paymentId: string | number,
  data: { refundAmount: number; reason: string; bankAccountId?: number | null },
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
      'INSERT INTO order_refunds (payment_id, order_id, refund_amount, reason, processed_by, bank_account_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [paymentId, payment.orderId, data.refundAmount.toFixed(2), data.reason, staffCtx.staffId, data.bankAccountId ?? null],
    );
    const refundId = String(refundRes.rows[0].id);

    // Auto-create bank reconciliation entry for bank refunds
    if (data.bankAccountId) {
      await client.query(
        `INSERT INTO bank_reconciliation (bank_account_id, refund_ref_id, amount, direction, status)
         VALUES ($1, $2, $3, 'out', 'uncleared')`,
        [data.bankAccountId, refundId, data.refundAmount.toFixed(2)],
      );
    }

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

    // Emit refund notification
    const orderNumRes = await client.query('SELECT order_number FROM orders WHERE id = $1', [payment.orderId]);
    const orderNumber = orderNumRes.rows[0]?.order_number ?? String(payment.orderId);
    await insertOutbox(client, 'payment.refunded', {
      paymentId: String(paymentId), refundId, amount: data.refundAmount, orderNumber, orderId: payment.orderId, branchId: staffCtx.branchId,
    });

    await client.query('COMMIT');

    const row = await db.query('SELECT * FROM order_refunds WHERE id = $1', [refundId]);
    return mapRefundRow(row.rows[0]);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

// ── listUnpaidOrders — orders awaiting payment (unpaid or partial) ────────────

export async function listUnpaidOrders(opts: {
  branchId?: number;
  customerId?: number;
  page?: number;
  pageSize?: number;
}): Promise<{
  items: Array<{
    id: string; orderNumber: string; customerName: string | null; customerCode: string | null;
    total: number; totalPaid: number; outstanding: number; paymentStatus: string;
    status: string; channel: string; createdAt: string;
    sourceType?: string;
  }>;
  total: number; page: number; totalPages: number;
}> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset = (page - 1) * pageSize;
  
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.branchId) { params.push(opts.branchId); conditions.push(`u.branch_id = $${params.length}`); }
  if (opts.customerId) { params.push(opts.customerId); conditions.push(`u.customer_id = $${params.length}`); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const li = params.length + 1;
  const oi = params.length + 2;

  const queryText = `
    WITH u AS (
      SELECT
        o.id::text AS id,
        o.order_number,
        o.total,
        o.payment_status,
        o.status,
        o.channel,
        o.created_at,
        c.full_name AS customer_name,
        c.customer_code,
        COALESCE(p.total_paid, 0) AS total_paid,
        'order' AS source_type,
        o.branch_id,
        o.customer_id
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN (
        SELECT order_id, SUM(amount) AS total_paid
        FROM order_payments
        WHERE status IN ('success','partially_refunded','refunded')
        GROUP BY order_id
      ) p ON p.order_id = o.id
      WHERE (
        -- Only credit_sale orders can have unpaid/partial status and appear here.
        -- Cash orders always have payment_status='paid' after confirm, so the
        -- sale_type guard below is defensive (catches any legacy cash order data).
        (o.sale_type = 'credit_sale'
          AND o.payment_status IN ('unpaid','partial')
          AND o.status NOT IN ('Cancelled', 'DRAFT', 'Pending'))
        OR
        -- Task 8.1: FULFILLED/COMPLETED credit_sale orders with outstanding balance.
        -- Bug condition C2: these fell out of the list because COMPLETED status
        -- was not included. CASH orders are excluded by the sale_type filter.
        (o.sale_type = 'credit_sale'
          AND o.status IN ('FULFILLED', 'COMPLETED', 'Fulfilled')
          AND (
            SELECT COALESCE(SUM(op.amount), 0)
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status IN ('success','partially_refunded','refunded')
          ) < o.total - 0.01)
      )
      AND o.status != 'Cancelled'
      UNION ALL
      SELECT
        t.id::text AS id,
        t.transaction_number AS order_number,
        t.grand_total AS total,
        t.payment_status,
        t.status,
        'POS' AS channel,
        t.created_at,
        c.full_name AS customer_name,
        c.customer_code,
        t.amount_paid AS total_paid,
        'pos' AS source_type,
        t.branch_id,
        t.customer_id
      FROM transactions t
      LEFT JOIN customers c ON c.id = t.customer_id
      JOIN receivables r ON r.source_type = 'pos_credit_sale' AND r.source_entity_id = t.id
      WHERE r.status IN ('Pending', 'PartiallyPaid', 'Overdue')
        AND t.status = 'completed'
    )
    SELECT * FROM u
    ${where}
    ORDER BY u.created_at DESC
    LIMIT $${li} OFFSET $${oi}
  `;

  const countQueryText = `
    WITH u AS (
      SELECT
        o.id,
        o.branch_id,
        o.customer_id
      FROM orders o
      WHERE (
        (o.sale_type = 'credit_sale'
          AND o.payment_status IN ('unpaid','partial')
          AND o.status NOT IN ('Cancelled', 'DRAFT', 'Pending'))
        OR
        (o.sale_type = 'credit_sale'
          AND o.status IN ('FULFILLED', 'COMPLETED', 'Fulfilled')
          AND (
            SELECT COALESCE(SUM(op.amount), 0)
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status IN ('success','partially_refunded','refunded')
          ) < o.total - 0.01)
      )
      AND o.status != 'Cancelled'
      UNION ALL
      SELECT
        t.id,
        t.branch_id,
        t.customer_id
      FROM transactions t
      JOIN receivables r ON r.source_type = 'pos_credit_sale' AND r.source_entity_id = t.id
      WHERE r.status IN ('Pending', 'PartiallyPaid', 'Overdue')
        AND t.status = 'completed'
    )
    SELECT COUNT(*) FROM u
    ${where}
  `;

  const [countRes, dataRes] = await Promise.all([
    db.query(countQueryText, params),
    db.query(queryText, [...params, pageSize, offset]),
  ]);

  return {
    items: dataRes.rows.map(r => {
      const total = parseFloat(r.total ?? '0');
      const totalPaid = parseFloat(r.total_paid ?? '0');
      return {
        id: String(r.id),
        orderNumber: r.order_number as string,
        customerName: (r.customer_name as string | null) ?? null,
        customerCode: (r.customer_code as string | null) ?? null,
        total,
        totalPaid,
        outstanding: Math.max(0, parseFloat((total - totalPaid).toFixed(2))),
        paymentStatus: r.payment_status as string,
        status: r.status as string,
        channel: r.channel as string,
        createdAt: (r.created_at as Date).toISOString(),
        sourceType: r.source_type as string,
      };
    }),
    total: parseInt(countRes.rows[0].count as string, 10),
    page,
    totalPages: Math.ceil(parseInt(countRes.rows[0].count as string, 10) / pageSize),
  };
}

// ── getOrderBalance — orders awaiting payment (unpaid or partial) ─────────────

export async function getOrderBalance(orderId: string | number): Promise<{
  orderTotal: number;
  totalPaid: number;
  totalRefunded: number;
  outstanding: number;
  paymentStatus: string;
}> {
  const orderRes = await db.query('SELECT total, payment_status FROM orders WHERE id = $1', [orderId]);
  if (!orderRes.rows.length) throw new NotFoundError('Order');
  const rawTotal = orderRes.rows[0].total;
  if (rawTotal == null) throw new BusinessError('ORDER_INVALID', 'Order has no total amount. The order may have been created with books that have no price set.');
  const orderTotal = parseFloat(rawTotal as string);
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
