import { sql } from 'kysely';
import type { Queryable } from '../../db/tx.js';

/** The last good backup run and the last failed one (#244). */
export async function lastRuns(q: Queryable): Promise<{
  success: { finishedAt: Date; fileName: string } | null;
  failure: { finishedAt: Date; error: string } | null;
}> {
  const [success, failure] = await Promise.all([
    q.selectFrom('backup_runs').select(['finished_at', 'file_name']).where('ok', '=', true)
      .orderBy('finished_at', 'desc').limit(1).executeTakeFirst(),
    q.selectFrom('backup_runs').select(['finished_at', 'error']).where('ok', '=', false)
      .orderBy('finished_at', 'desc').limit(1).executeTakeFirst(),
  ]);
  return {
    success: success ? { finishedAt: new Date(success.finished_at), fileName: success.file_name ?? '' } : null,
    failure: failure ? { finishedAt: new Date(failure.finished_at), error: failure.error ?? '' } : null,
  };
}

/** The database's clock, so the warning does not depend on the API container's. */
export async function now(q: Queryable): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(q);
  return new Date(rows[0].now);
}
