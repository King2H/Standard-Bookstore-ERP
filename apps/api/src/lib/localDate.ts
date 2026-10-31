import { sql } from 'kysely';
import type { Queryable } from '../db/tx.js';

/**
 * The shop's local date today, YYYY-MM-DD. Connections work in the shop's
 * time zone (#175, db/index.ts), so this is the day its staff are working,
 * not the UTC one.
 */
export async function localToday(q: Queryable): Promise<string> {
  const { rows } = await sql<{ today: string }>`SELECT CURRENT_DATE::text AS today`.execute(q);
  return rows[0].today;
}
