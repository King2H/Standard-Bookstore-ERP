import { Pool, type PoolClient } from 'pg';
import { currentTenant } from './tenantContext.js';

// Pool is created lazily — DATABASE_URL is validated at first use, not at import time
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Every connection handed out carries the tenant of the work that asked for
// it (#13), or none outside a request or job. Pool connections are shared,
// so it is set on each checkout, never left from the previous user. Kysely,
// withTransaction and pool.query all check out through here.
const checkout = db.connect.bind(db) as () => Promise<PoolClient>;
async function connectForTenant(): Promise<PoolClient> {
  const client = await checkout();
  try {
    const tenant = currentTenant();
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant === undefined ? '' : String(tenant)]);
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

export async function checkDbConnection(): Promise<boolean> {
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
