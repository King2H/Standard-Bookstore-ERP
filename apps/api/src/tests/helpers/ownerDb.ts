import pg from 'pg';

/**
 * The owner's connection to the test database. Row-level security (#13)
 * does not apply to it, so tests use it for what the API's user may not do:
 * create tenants, write fixtures in several tenants, and look across them.
 * Everything else goes through `db`, as the API's user.
 */
let pool: pg.Pool | undefined;

export function ownerDb(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
  return pool;
}

export async function closeOwnerDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
