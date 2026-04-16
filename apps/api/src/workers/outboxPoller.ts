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

const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 50;

let running = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

type EventHandler = (payload: Record<string, unknown>) => Promise<void>;

const HANDLERS: Record<string, EventHandler> = {
  LoyaltyAccrualRequested: handleLoyaltyAccrual,
  // Future: add more handlers here as workers are implemented
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
          await handler(payload);
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
