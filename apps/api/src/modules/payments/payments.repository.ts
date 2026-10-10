import { sql, type RawBuilder } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import {
  toPaymentRecord,
  toRefundRecord,
  toUnpaidRecord,
  type PaymentRow,
  type RefundRow,
  type UnpaidRow,
} from './payments.mapper.js';
import type {
  NewPayment,
  OrderForPayment,
  OrderPaymentStatus,
  OrderTakings,
  PaymentFilter,
  PaymentRecord,
  PaymentStatus,
  RefundRecord,
  UnpaidFilter,
  UnpaidRecord,
} from './payments.types.js';

// Payments belong to their order's branch (#12). Lists take the branch the
// controller scoped; single records are checked by recordInBranch() on the
// route, and a new payment's order by the service.

type Page = { limit: number; offset: number };

/** Payments whose money was received, including those refunded since. */
const RECEIVED = ['success', 'partially_refunded', 'refunded'];

// ── Orders ────────────────────────────────────────────────────────────────────

/** The order a payment or refund is for; with `forUpdate`, locked until the transaction ends. */
export async function findOrder(q: Queryable, orderId: string, opts: { forUpdate?: boolean } = {}): Promise<OrderForPayment | undefined> {
  let query = q
    .selectFrom('orders')
    .select(['id', 'order_number', 'branch_id', 'status', 'sale_type', 'total', 'customer_id', 'payment_status'])
    .where('id', '=', orderId);
  if (opts.forUpdate) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  return (
    row && {
      id: String(row.id),
      orderNumber: row.order_number,
      branchId: row.branch_id,
      status: row.status,
      saleType: row.sale_type,
      total: row.total === null ? null : Money.of(row.total),
      customerId: row.customer_id,
      paymentStatus: row.payment_status,
    }
  );
}

export async function takings(q: Queryable, orderId: string): Promise<OrderTakings> {
  const [paid, refunded] = await Promise.all([
    q
      .selectFrom('order_payments')
      .select(sql<string>`COALESCE(SUM(amount), 0)`.as('total'))
      .where('order_id', '=', orderId)
      .where('status', 'in', RECEIVED)
      .executeTakeFirstOrThrow(),
    q
      .selectFrom('order_refunds')
      .select(sql<string>`COALESCE(SUM(refund_amount), 0)`.as('total'))
      .where('order_id', '=', orderId)
      .executeTakeFirstOrThrow(),
  ]);
  return { paid: Money.of(paid.total), refunded: Money.of(refunded.total) };
}

export async function setOrderPaymentStatus(q: Queryable, orderId: string, status: OrderPaymentStatus): Promise<void> {
  await q.updateTable('orders').set({ payment_status: status, updated_at: sql<Date>`now()` }).where('id', '=', orderId).execute();
}

// ── Payments ──────────────────────────────────────────────────────────────────

const PAYMENT_COLUMNS = [
  'id',
  'payment_reference',
  'order_id',
  'amount',
  'currency',
  'payment_method',
  'status',
  'transaction_reference',
  'notes',
  'processed_at',
  'created_at',
  'processed_by',
  'bank_account_id',
] as const;

export async function findPayment(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<PaymentRecord | undefined> {
  let query = q.selectFrom('order_payments').select(PAYMENT_COLUMNS).where('id', '=', id);
  if (opts.forUpdate) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  return row && toPaymentRecord(row as PaymentRow);
}

export async function paymentsOfOrder(q: Queryable, orderId: string): Promise<PaymentRecord[]> {
  const rows = await q
    .selectFrom('order_payments')
    .select(PAYMENT_COLUMNS)
    .where('order_id', '=', orderId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map((r) => toPaymentRecord(r as PaymentRow));
}

export async function insertPayment(
  q: Queryable,
  p: NewPayment & { reference: string; processedBy: number },
): Promise<string> {
  const row = await q
    .insertInto('order_payments')
    .values({
      payment_reference: p.reference,
      order_id: p.orderId,
      amount: p.amount.toFixed(2),
      currency: 'ETB',
      payment_method: p.paymentMethod,
      status: 'success',
      transaction_reference: p.transactionReference,
      notes: p.notes,
      processed_by: p.processedBy,
      bank_account_id: p.bankAccountId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return String(row.id);
}

export async function setPaymentStatus(q: Queryable, id: string, status: PaymentStatus): Promise<void> {
  await q.updateTable('order_payments').set({ status }).where('id', '=', id).execute();
}

// ── Refunds ───────────────────────────────────────────────────────────────────

const REFUND_COLUMNS = [
  'id',
  'payment_id',
  'order_id',
  'refund_amount',
  'reason',
  'method',
  'bank_account_id',
  'processed_by',
  'created_at',
] as const;

export async function refundsOf(q: Queryable, paymentId: string): Promise<RefundRecord[]> {
  const rows = await q.selectFrom('order_refunds').select(REFUND_COLUMNS).where('payment_id', '=', paymentId).orderBy('id').execute();
  return rows.map((r) => toRefundRecord(r as RefundRow));
}

export async function insertRefund(
  q: Queryable,
  r: { payment: PaymentRecord; amount: Money; reason: string; bankAccountId: number | null; processedBy: number },
): Promise<RefundRecord> {
  const row = await q
    .insertInto('order_refunds')
    .values({
      payment_id: r.payment.id,
      order_id: r.payment.orderId,
      refund_amount: r.amount.toFixed(2),
      reason: r.reason,
      method: r.payment.paymentMethod,
      bank_account_id: r.bankAccountId,
      processed_by: r.processedBy,
    })
    .returning(REFUND_COLUMNS)
    .executeTakeFirstOrThrow();
  return toRefundRecord(row as RefundRow);
}

// ── Bank ──────────────────────────────────────────────────────────────────────

export async function findBankAccount(q: Queryable, id: number): Promise<{ isActive: boolean; branchId: number } | undefined> {
  const row = await q.selectFrom('bank_accounts').select(['is_active', 'branch_id']).where('id', '=', id).executeTakeFirst();
  return row && { isActive: row.is_active, branchId: row.branch_id };
}

/** An uncleared bank movement, to be matched against the statement. */
export async function insertBankReconciliation(
  q: Queryable,
  e: { bankAccountId: number; amount: Money } & ({ paymentId: string } | { refundId: string }),
): Promise<void> {
  await q
    .insertInto('bank_reconciliation')
    .values({
      bank_account_id: e.bankAccountId,
      amount: e.amount.toFixed(2),
      status: 'uncleared',
      ...('paymentId' in e ? { payment_ref_id: e.paymentId, direction: 'in' } : { refund_ref_id: e.refundId, direction: 'out' }),
    })
    .execute();
}

// ── Lists ─────────────────────────────────────────────────────────────────────

function whereAll(conditions: RawBuilder<unknown>[]): RawBuilder<unknown> {
  return conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
}

/**
 * Payment history of a branch: order payments, collections on POS credit
 * sales, and collections on exchange differences (booked in the ledger),
 * newest first.
 */
export async function listHistory(q: Queryable, filter: PaymentFilter, page: Page): Promise<{ items: PaymentRecord[]; total: number }> {
  const conditions: RawBuilder<unknown>[] = [sql`u.branch_id = ${filter.branchId}`];
  if (filter.orderId !== undefined) conditions.push(sql`u.order_id = ${String(filter.orderId)}`);
  if (filter.status) conditions.push(sql`u.status = ${filter.status}`);
  if (filter.paymentMethod) conditions.push(sql`u.payment_method = ${filter.paymentMethod}`);
  if (filter.dateFrom) conditions.push(sql`u.created_at >= ${filter.dateFrom}::date`);
  // Through the end of that day.
  if (filter.dateTo) conditions.push(sql`u.created_at < ${filter.dateTo}::date + 1`);
  const where = whereAll(conditions);

  const history = sql`
    SELECT p.id::text AS id, p.payment_reference, p.order_id::text AS order_id, o.order_number AS entity_number,
           'order' AS source_type, p.amount, p.currency, p.payment_method, p.status, p.transaction_reference,
           p.notes, p.processed_at, p.created_at, p.processed_by, p.bank_account_id, o.status AS order_status, o.branch_id
    FROM order_payments p
    JOIN orders o ON o.id = p.order_id
    UNION ALL
    SELECT tp.id::text, COALESCE(tp.reference, 'PAY-POS-' || tp.id), t.id::text, t.transaction_number,
           'pos', tp.amount, 'ETB', tp.method, 'success', tp.reference,
           'POS Credit Sale Collection', tp.created_at, tp.created_at, t.staff_id, NULL::integer, NULL::text, t.branch_id
    FROM transaction_payments tp
    JOIN transactions t ON t.id = tp.transaction_id
    JOIN receivables r ON r.source_type = 'pos_credit_sale' AND r.source_entity_id = t.id
    UNION ALL
    SELECT ft.id::text, 'PAY-EXC-' || ft.id, e.id::text, e.exchange_reference,
           'exchange', ft.amount, ft.currency, ft.method, 'success', NULL::text,
           'Exchange Receivable Collection', ft.created_at, ft.created_at, ft.staff_id, NULL::integer, NULL::text, e.branch_id
    FROM financial_transactions ft
    JOIN exchanges e ON e.id = ft.exchange_id
    WHERE ft.type = 'payment'`;

  const [rows, count] = await Promise.all([
    sql<PaymentRow>`WITH u AS (${history}) SELECT * FROM u ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT ${page.limit} OFFSET ${page.offset}`.execute(q),
    sql<{ count: string }>`WITH u AS (${history}) SELECT COUNT(*) AS count FROM u ${where}`.execute(q),
  ]);
  return { items: rows.rows.map(toPaymentRecord), total: Number(count.rows[0].count) };
}

/**
 * What customers still owe in a branch: credit orders not fully paid (net of
 * refunds), POS credit sales and exchange differences with an open
 * receivable. A written-off or cancelled debt is not listed.
 */
export async function listUnpaid(q: Queryable, filter: UnpaidFilter, page: Page): Promise<{ items: UnpaidRecord[]; total: number }> {
  const conditions: RawBuilder<unknown>[] = [sql`u.branch_id = ${filter.branchId}`];
  if (filter.customerId !== undefined) conditions.push(sql`u.customer_id = ${filter.customerId}`);
  if (filter.entityId) conditions.push(sql`u.id = ${filter.entityId}`);
  if (filter.sourceType) conditions.push(sql`u.source_type = ${filter.sourceType}`);
  const where = whereAll(conditions);

  const unpaid = sql`
    SELECT o.id::text AS id, o.order_number, o.total, o.payment_status, o.status, o.channel, o.created_at,
           c.full_name AS customer_name, c.customer_code, n.net_paid AS total_paid,
           'order' AS source_type, o.branch_id, o.customer_id
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    CROSS JOIN LATERAL (
      SELECT COALESCE((SELECT SUM(amount) FROM order_payments WHERE order_id = o.id AND status IN (${sql.join(RECEIVED)})), 0)
           - COALESCE((SELECT SUM(refund_amount) FROM order_refunds WHERE order_id = o.id), 0) AS net_paid
    ) n
    WHERE o.sale_type = 'credit_sale'
      AND upper(o.status) NOT IN ('CANCELLED', 'DRAFT', 'PENDING')
      AND n.net_paid < o.total
      AND NOT EXISTS (
        SELECT 1 FROM receivables wr
        WHERE wr.source_type = 'order_credit_sale' AND wr.source_entity_id = o.id AND wr.status = 'WrittenOff'
      )
    UNION ALL
    SELECT t.id::text, t.transaction_number, t.grand_total, t.payment_status, t.status, 'POS', t.created_at,
           c.full_name, c.customer_code, t.amount_paid, 'pos', t.branch_id, t.customer_id
    FROM transactions t
    LEFT JOIN customers c ON c.id = t.customer_id
    JOIN receivables r ON r.source_type = 'pos_credit_sale' AND r.source_entity_id = t.id
    WHERE r.status IN ('Pending', 'PartiallyPaid', 'Overdue') AND t.status = 'completed'
    UNION ALL
    SELECT r.id::text, e.exchange_reference, r.original_amount,
           CASE WHEN r.status = 'PartiallyPaid' THEN 'partial' ELSE 'unpaid' END, r.status, 'Exchange', r.created_at,
           c.full_name, c.customer_code, r.original_amount - r.outstanding_amount, 'exchange_difference', r.branch_id, r.customer_id
    FROM receivables r
    JOIN exchanges e ON e.id = r.source_entity_id
    LEFT JOIN customers c ON c.id = r.customer_id
    WHERE r.source_type = 'exchange_difference' AND r.status IN ('Pending', 'PartiallyPaid', 'Overdue')`;

  const [rows, count] = await Promise.all([
    sql<UnpaidRow>`WITH u AS (${unpaid}) SELECT * FROM u ${where} ORDER BY u.created_at DESC, u.source_type, u.id DESC LIMIT ${page.limit} OFFSET ${page.offset}`.execute(q),
    sql<{ count: string }>`WITH u AS (${unpaid}) SELECT COUNT(*) AS count FROM u ${where}`.execute(q),
  ]);
  return { items: rows.rows.map(toUnpaidRecord), total: Number(count.rows[0].count) };
}
