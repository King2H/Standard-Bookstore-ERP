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
  | 'TransactionCompleted'
  | 'TransactionVoided'
  | 'LoyaltyAccrualRequested'
  | 'ReturnCompleted'
  | 'OrderStatusChanged'
  | 'POApprovalRequired'
  | 'InstallmentOverdue'
  | 'LowStockAlert'
  | 'ExchangeCompleted'
  | 'ConfigChanged';

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
