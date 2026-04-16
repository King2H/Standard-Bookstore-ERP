/**
 * Installment Checker — daily cron that marks overdue installments.
 * Runs at startup and then every 24 hours.
 * Also handles InstallmentOverdue outbox events (for future notification routing).
 *
 * An installment is overdue when:
 *   due_date + installment_grace_period_days < now()
 *   AND status IN ('pending', 'partial')
 *   AND paid_amount < amount
 */
import { db } from '../db/index.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let checkTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

/**
 * Scan installments and flip overdue ones.
 * Returns the count of installments marked overdue.
 */
export async function runInstallmentCheck(): Promise<number> {
  // Get grace period from config (default 0 days)
  let graceDays = 0;
  try {
    const res = await db.query(`SELECT value FROM system_config WHERE key = 'installment_grace_period_days'`);
    if (res.rows.length) graceDays = Number(res.rows[0].value) || 0;
  } catch { /* use default */ }

  const result = await db.query(
    `UPDATE installments
     SET status = 'overdue'
     WHERE status IN ('pending', 'partial')
       AND paid_amount < amount
       AND due_date + ($1 || ' days')::INTERVAL < now()
     RETURNING id, order_id, plan_id, due_date, amount, paid_amount`,
    [graceDays],
  );

  const count = result.rows.length;

  if (count > 0) {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'Installment checker: marked overdue',
      count,
      graceDays,
    }));

    // Insert outbox events for each overdue installment (for future notification routing)
    for (const row of result.rows) {
      try {
        await db.query(
          `INSERT INTO outbox (event_type, payload, status, created_at)
           VALUES ('InstallmentOverdue', $1::jsonb, 'pending', now())`,
          [JSON.stringify({
            installmentId: row.id,
            orderId: row.order_id,
            planId: row.plan_id,
            dueDate: row.due_date,
            amount: row.amount,
            paidAmount: row.paid_amount,
          })],
        );
      } catch { /* non-critical — continue */ }
    }
  }

  return count;
}

/**
 * Handle InstallmentOverdue outbox events.
 * Currently logs; future: send notification via notification worker.
 */
export async function handleInstallmentOverdue(payload: Record<string, unknown>): Promise<void> {
  console.log(JSON.stringify({
    level: 'info',
    msg: 'InstallmentOverdue event received',
    installmentId: payload.installmentId,
    orderId: payload.orderId,
    dueDate: payload.dueDate,
  }));
  // Future: enqueue notification to customer/staff
}

export function startInstallmentChecker(): void {
  if (running) return;
  running = true;

  const tick = async () => {
    if (!running) return;
    try {
      await runInstallmentCheck();
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'Installment checker error', error: (err as Error).message }));
    }
    if (running) {
      checkTimer = setTimeout(tick, CHECK_INTERVAL_MS);
    }
  };

  // Run immediately on startup, then every 24h
  tick();
  console.log(JSON.stringify({ level: 'info', msg: 'Installment checker started' }));
}

export function stopInstallmentChecker(): void {
  running = false;
  if (checkTimer) {
    clearTimeout(checkTimer);
    checkTimer = null;
  }
}
