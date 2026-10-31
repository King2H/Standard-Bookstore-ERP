import { Pool, type PoolClient } from 'pg';
import { currentWork, NoTenantError, runWithoutTenant } from './tenantContext.js';

// Pool is created lazily — DATABASE_URL is validated at first use, not at import time
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Every connection handed out carries the tenant of the work that asked for
// it (#13), and works in that shop's time zone (#175), so its dates are the
// shop's local days. Pool connections are shared, so it is set on each checkout,
// never left from the previous user. Kysely, withTransaction and pool.query
// all check out through here, so this is also where work that forgot its
// tenant is stopped (ADR-0003): it gets no connection at all, rather than a
// quietly empty answer from row-level security. Work that needs no tenant
// says so with runWithoutTenant.
const checkout = db.connect.bind(db) as () => Promise<PoolClient>;
async function connectForTenant(): Promise<PoolClient> {
  const work = currentWork();
  if (!work) throw new NoTenantError();
  const client = await checkout();
  try {
    await client.query(`SELECT apply_tenant($1)`, ['tenantId' in work ? String(work.tenantId) : '']);
  } catch (err) {
    client.release(err as Error);
    throw err;
  }
  return client;
}
db.connect = ((callback?: (err: Error | undefined, client?: PoolClient, done?: (release?: unknown) => void) => void) => {
  if (!callback) return connectForTenant();
  // pool.query checks out with a callback.
  connectForTenant().then(
    (client) => callback(undefined, client, (release?: unknown) => client.release(release as Error | boolean | undefined)),
    (err: Error) => callback(err),
  );
  return undefined;
}) as typeof db.connect;

db.on('error', (err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'Unexpected DB pool error', err: err.message }));
});

export function checkDbConnection(): Promise<boolean> {
  return runWithoutTenant('checking the database connection', checkConnection);
}

async function checkConnection(): Promise<boolean> {
  if (!process.env.DATABASE_URL) {
    console.error(JSON.stringify({ level: 'error', msg: 'DATABASE_URL environment variable is not set' }));
    return false;
  }
  try {
    const client = await db.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch {
    return false;
  }
}

/**
 * Why the API must not run as the user DATABASE_URL names, or undefined if it
 * may. Row-level security (#13) does not apply to a superuser, to a role that
 * bypasses it, or to the tables' owner, so the API refuses to start as one of
 * them: tenants would not be kept apart. Migrations run as the owner through
 * MIGRATION_DATABASE_URL instead.
 */
export async function appRoleProblem(): Promise<string | undefined> {
  const { rows } = await runWithoutTenant('checking the database user', () => db.query<{ user: string; applies: boolean }>(
    `SELECT current_user AS user, row_security_active('branches') AS applies`,
  ));
  return rows[0].applies ? undefined : `row-level security does not apply to database user "${rows[0].user}"`;
}
