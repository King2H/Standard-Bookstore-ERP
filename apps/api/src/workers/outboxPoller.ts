/**
 * Outbox Poller — runs continuously, polling the outbox table every 1 second.
 * Routes events to the appropriate in-process handler.
 * Uses SELECT FOR UPDATE SKIP LOCKED for safe concurrent polling.
 *
 * In this implementation, workers run in-process (no BullMQ yet).
 * The outbox table provides guaranteed delivery even if the process crashes mid-write.
 */
import { db } from '../db/index.js';
import { handleLoyaltyAccrual } from './loyaltyWorker.js';
import { handleInstallmentOverdue } from './installmentChecker.js';
import { handleNotification } from './notificationWorker.js';

const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 50;

let running = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

type EventHandler = (payload: Record<string, unknown>) => Promise<void>;

const HANDLERS: Record<string, EventHandler> = {
  LoyaltyAccrualRequested: handleLoyaltyAccrual,
  // Legacy Code Audit finding: installmentChecker.ts's daily cron has always
  // inserted 'InstallmentOverdue' (PascalCase) outbox rows and imported
  // handleInstallmentOverdue specifically to process them, but this map
  // never had a matching key — every such event silently fell through
  // pollOnce()'s handler lookup and was marked failed with no side effect.
  // (Distinct from the newer Phase 5 'installment.overdue' — dot-case —
  // notification event, which IS routed below but is never actually
  // emitted anywhere via insertOutbox(); that gap is unrelated and left
  // as-is, flagged separately.) Wiring this up is additive/log-only
  // (handleInstallmentOverdue only console.logs today) — no user-facing
  // behavior changes, it just stops discarding an event that was always
  // meant to be handled.
  InstallmentOverdue: handleInstallmentOverdue,
  // Phase 5 — Notification system: all notification event types route to handleNotification
  'inventory.stock_in': handleNotification,
  'inventory.stock_out': handleNotification,
  'inventory.adjustment': handleNotification,
  'inventory.transfer_completed': handleNotification,
  'inventory.low_stock': handleNotification,
  'inventory.out_of_stock': handleNotification,
  'pos.sale_completed': handleNotification,
  'pos.credit_sale': handleNotification,
  'pos.transaction_voided': handleNotification,
  'pos.payment_collected': handleNotification,
  'order.created': handleNotification,
  'order.confirmed': handleNotification,
  'order.backordered': handleNotification,
  'order.in_progress': handleNotification,
  'order.fulfilled': handleNotification,
  'order.cancelled': handleNotification,
  'payment.recorded': handleNotification,
  'payment.refunded': handleNotification,
  'payment.bank_transfer': handleNotification,
  'installment.payment_recorded': handleNotification,
  'installment.overdue': handleNotification,
  'installment.plan_completed': handleNotification,
  'return.initiated': handleNotification,
  'return.approval_required': handleNotification,
  'return.approved': handleNotification,
  'return.rejected': handleNotification,
  'return.completed': handleNotification,
  'po.created': handleNotification,
  'po.approval_required': handleNotification,
  'po.approved': handleNotification,
  'po.ordered': handleNotification,
  'po.partially_received': handleNotification,
  'po.fully_received': handleNotification,
  'po.cancelled': handleNotification,
  'exchange.completed': handleNotification,
  'exchange.cancelled': handleNotification,
  'exchange.store_refund_due': handleNotification,
  'customer.store_credit_added': handleNotification,
  'customer.deactivated': handleNotification,
  'auth.failed_login_attempts': handleNotification,
  'auth.staff_deactivated': handleNotification,
  'auth.password_reset': handleNotification,
};

async function pollOnce(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query(
      `SELECT id, event_type, payload
       FROM outbox
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [BATCH_SIZE],
    );

    if (res.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    for (const row of res.rows) {
      const eventType = row.event_type as string;
      const payload = row.payload as Record<string, unknown>;
      const id = row.id as number;

      const handler = HANDLERS[eventType];
      if (handler) {
        try {
          // Inject routing metadata so handlers can access event_type without a separate param
          const enrichedPayload = { ...payload, _eventType: eventType, _outboxId: id };
          await handler(enrichedPayload);
          await client.query(
            `UPDATE outbox SET status = 'published', published_at = now() WHERE id = $1`,
            [id],
          );
        } catch (err) {
          // Mark as failed — will be retried on next poll if we add retry logic
          await client.query(
            `UPDATE outbox SET status = 'failed' WHERE id = $1`,
            [id],
          );
          console.error(JSON.stringify({
            level: 'error',
            msg: 'Outbox handler failed',
            eventType,
            outboxId: id,
            error: (err as Error).message,
          }));
        }
      } else {
        // No handler registered — mark as published (acknowledged)
        await client.query(
          `UPDATE outbox SET status = 'published', published_at = now() WHERE id = $1`,
          [id],
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(JSON.stringify({ level: 'error', msg: 'Outbox poll error', error: (err as Error).message }));
  } finally {
    client.release();
  }
}

export function startOutboxPoller(): void {
  if (running) return;
  running = true;
  console.log(JSON.stringify({ level: 'info', msg: 'Outbox poller started' }));

  const tick = async () => {
    if (!running) return;
    try {
      await pollOnce();
    } catch {
      // ignore — next tick will retry
    }
    if (running) {
      pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };

  pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
}

export function stopOutboxPoller(): void {
  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  console.log(JSON.stringify({ level: 'info', msg: 'Outbox poller stopped' }));
}
