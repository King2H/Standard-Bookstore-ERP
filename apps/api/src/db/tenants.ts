import { kysely } from './kysely.js';
import { runInTenant } from './tenantContext.js';

/**
 * Runs a background job once for each active tenant, in that tenant (#13):
 * jobs see and write only the tenant's rows, as requests do. One tenant's
 * failure is logged and does not stop the others.
 */
export async function forEachTenant(job: string, fn: (tenantId: number) => Promise<void>): Promise<void> {
  const tenants = await kysely.selectFrom('tenants').select('id').where('status', '=', 'active').orderBy('id').execute();
  for (const { id } of tenants) {
    try {
      await runInTenant(id, () => fn(id));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: `${job} failed`, tenantId: id, error: (err as Error).message }));
    }
  }
}
