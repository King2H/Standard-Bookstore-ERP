/**
 * Loyalty Accrual Worker.
 * Processes LoyaltyAccrualRequested events from the outbox.
 * Idempotent: checks if accrual already recorded for this transaction_ref.
 */
import { db } from '../db/index.js';
import { getLoyaltyAccrualRate, getLoyaltyMinTransactionAmount } from '../modules/config/config.service.js';

export interface LoyaltyAccrualPayload {
  customerId: number;
  transactionRef: string;
  subtotal: number;
  branchId: number;
}

export async function handleLoyaltyAccrual(payload: Record<string, unknown>): Promise<void> {
  const { customerId, transactionRef, subtotal, branchId } = payload as unknown as LoyaltyAccrualPayload;

  if (!customerId || !transactionRef || subtotal == null) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'LoyaltyAccrual: missing payload fields', payload }));
    return;
  }

  // Idempotency check — skip if already accrued for this transaction
  const existing = await db.query(
    `SELECT id FROM loyalty_history WHERE customer_id = $1 AND transaction_ref = $2 AND reason = 'ACCRUAL'`,
    [customerId, transactionRef],
  );
  if (existing.rows.length > 0) {
    // Already processed — idempotent skip
    return;
  }

  const rate = await getLoyaltyAccrualRate();
  const minAmount = await getLoyaltyMinTransactionAmount();

  if (subtotal < minAmount) return; // Below minimum — no accrual

  const points = Math.floor(subtotal * rate);
  if (points <= 0) return;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Optimistic lock on loyalty account
    const acctRes = await client.query(
      `SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1 FOR UPDATE`,
      [customerId],
    );
    if (!acctRes.rows.length) {
      // Customer has no loyalty account — skip silently
      await client.query('ROLLBACK');
      return;
    }

    await client.query(
      `UPDATE loyalty_accounts
       SET points_balance = points_balance + $1, lifetime_points = lifetime_points + $1, updated_at = now()
       WHERE customer_id = $2`,
      [points, customerId],
    );

    await client.query(
      `INSERT INTO loyalty_history (customer_id, transaction_ref, points_delta, reason)
       VALUES ($1, $2, $3, 'ACCRUAL')`,
      [customerId, transactionRef, points],
    );

    await client.query('COMMIT');

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Loyalty accrual processed',
      customerId,
      transactionRef,
      points,
      branchId,
    }));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
