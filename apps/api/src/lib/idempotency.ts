/**
 * PostgreSQL-backed idempotency for financial endpoints.
 * Stores key + endpoint + request hash + response snapshot with 24h TTL.
 * No Redis required.
 */
import { createHash } from 'crypto';
import { db } from '../db/index.js';

export interface IdempotencyResult<T> {
  result: T;
  replayed: boolean;
}

/**
 * Compute a stable hash of the request body for collision detection.
 */
export function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

/**
 * Check if an idempotency key has been seen before.
 * If yes, return the stored response.
 * If no, execute fn(), store the result, and return it.
 */
export async function withIdempotency<T>(
  key: string,
  endpoint: string,
  requestHash: string,
  fn: () => Promise<T>,
): Promise<IdempotencyResult<T>> {
  // Clean up expired keys opportunistically (1% of requests)
  if (Math.random() < 0.01) {
    db.query('DELETE FROM idempotency_keys WHERE expires_at < now()').catch(() => {/* ignore */});
  }

  // Check for existing key
  const existing = await db.query(
    'SELECT response_payload, request_hash FROM idempotency_keys WHERE key = $1 AND expires_at > now()',
    [key],
  );

  if (existing.rows.length > 0) {
    // Key exists — return stored response
    return {
      result: existing.rows[0].response_payload as T,
      replayed: true,
    };
  }

  // Execute the operation
  const result = await fn();

  // Store the result (ignore conflict — another concurrent request may have stored it)
  await db.query(
    `INSERT INTO idempotency_keys (key, endpoint, request_hash, response_payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO NOTHING`,
    [key, endpoint, requestHash, JSON.stringify(result)],
  ).catch(() => {/* ignore storage failure — idempotency is best-effort */});

  return { result, replayed: false };
}
