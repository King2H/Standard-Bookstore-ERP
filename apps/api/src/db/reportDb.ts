import { CompiledQuery } from 'kysely';
import { kysely } from './kysely.js';
import type { Queryable } from './tx.js';

/**
 * Where reports read (#22). Reports only read, so they can move to a read
 * replica later by pointing this at a second connection; until there is one
 * it is the primary.
 */
export const reportDb: Queryable = kysely;

/**
 * Runs a report's parameterized SQL ($1, $2, ... with `params`) on `q`.
 * Report queries are large hand-written aggregates; they keep their SQL text
 * and run through Kysely like every other repository. Never interpolate
 * request input into `text`: values go in `params`.
 */
export async function reportRows<R = Record<string, unknown>>(q: Queryable, text: string, params: readonly unknown[] = []): Promise<R[]> {
  const result = await q.executeQuery<R>(CompiledQuery.raw(text, [...params]));
  return result.rows;
}
