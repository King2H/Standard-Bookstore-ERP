import { db } from '../../db/index.js';
import { PoolClient } from 'pg';

/**
 * Wraps a test in a DB transaction that is always rolled back.
 * This ensures test isolation without needing to truncate tables.
 */
export async function withTestTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cleans specific tables between tests when transaction rollback isn't sufficient.
 */
export async function cleanTables(...tables: string[]): Promise<void> {
  const client = await db.connect();
  try {
    // Disable FK checks temporarily, truncate, re-enable
    await client.query('BEGIN');
    for (const table of tables) {
      await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
