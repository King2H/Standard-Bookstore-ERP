/**
 * Outbox pattern helper.
 * Inserts domain events into the outbox table within the caller's DB transaction.
 * The Outbox_Poller worker picks these up and routes them to BullMQ queues.
 *
 * Usage:
 *   await insertOutbox(client, 'TransactionCompleted', { transactionId, customerId, subtotal });
 */
import type { PoolClient } from 'pg';

export type OutboxEventType =
  // ── Legacy / existing ────────────────────────────────────────────────────
  | 'TransactionCompleted'
  | 'TransactionVoided'
  | 'LoyaltyAccrualRequested'
  | 'ReturnCompleted'
  | 'OrderStatusChanged'
  | 'POApprovalRequired'
  | 'InstallmentOverdue'
  | 'LowStockAlert'
  | 'ExchangeCompleted'
  | 'ConfigChanged'
  // ── Phase 5 — Notification system events ─────────────────────────────────
  // Inventory
  | 'inventory.stock_in'
  | 'inventory.stock_out'
  | 'inventory.adjustment'
  | 'inventory.transfer_completed'
  | 'inventory.low_stock'
  | 'inventory.out_of_stock'
  // POS
  | 'pos.sale_completed'
  | 'pos.credit_sale'
  | 'pos.transaction_voided'
  | 'pos.payment_collected'
  // Orders
  | 'order.created'
  | 'order.confirmed'
  | 'order.backordered'
  | 'order.in_progress'
  | 'order.fulfilled'
  | 'order.cancelled'
  // Payments
  | 'payment.recorded'
  | 'payment.refunded'
  | 'payment.bank_transfer'
  | 'installment.payment_recorded'
  | 'installment.overdue'
  | 'installment.plan_completed'
  // Returns
  | 'return.initiated'
  | 'return.approval_required'
  | 'return.approved'
  | 'return.rejected'
  | 'return.completed'
  // Procurement
  | 'po.created'
  | 'po.approval_required'
  | 'po.approved'
  | 'po.ordered'
  | 'po.partially_received'
  | 'po.fully_received'
  | 'po.cancelled'
  // Exchanges
  | 'exchange.completed'
  | 'exchange.cancelled'
  | 'exchange.store_refund_due'
  // Customers
  | 'customer.store_credit_added'
  | 'customer.deactivated'
  // Auth / Security
  | 'auth.failed_login_attempts'
  | 'auth.staff_deactivated'
  | 'auth.password_reset';

/**
 * Insert an outbox event within an existing DB transaction.
 * The event will be picked up by the Outbox_Poller and routed to the appropriate worker.
 */
export async function insertOutbox(
  client: PoolClient,
  eventType: OutboxEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox (event_type, payload, status, created_at)
     VALUES ($1, $2::jsonb, 'pending', now())`,
    [eventType, JSON.stringify(payload)],
  );
}
