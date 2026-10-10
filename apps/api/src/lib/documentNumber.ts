import { sql } from 'kysely';
import type { Queryable } from '../db/tx.js';

/**
 * The next number of a daily document series, e.g. PAY-20261010-0007, in the
 * database's calendar. The counter row stays locked until `q`'s transaction
 * ends, so concurrent documents never share a number; a rolled-back
 * transaction leaves a gap.
 */
export async function nextDailyNumber(q: Queryable, series: string): Promise<string> {
  const { rows } = await sql<{ period: string; last_value: number }>`
    INSERT INTO document_counters (series, period, last_value)
    VALUES (${series}, TO_CHAR(CURRENT_DATE, 'YYYYMMDD'), 1)
    ON CONFLICT (series, period) DO UPDATE SET last_value = document_counters.last_value + 1
    RETURNING period, last_value`.execute(q);
  return `${series}-${rows[0].period}-${String(rows[0].last_value).padStart(4, '0')}`;
}
