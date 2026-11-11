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

/**
 * Removes test shops (tenants named like `pattern`) and every row they own,
 * table by table, as their foreign keys allow: a table whose rows are still
 * referenced is tried again on the next pass.
 */
export async function deleteTestTenants(pattern: string): Promise<void> {
  const db = ownerDb();
  const tenants = `SELECT id FROM tenants WHERE name LIKE '${pattern.replace(/'/g, "''")}'`;
  if ((await db.query(tenants)).rowCount === 0) return;
  let tables = (await db.query<{ name: string }>(
    `SELECT DISTINCT c.table_name AS name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND c.table_name <> 'tenants'`,
  )).rows.map((r) => r.name);
  await db.query(`DELETE FROM refresh_tokens WHERE session_id IN (SELECT id FROM staff_sessions WHERE tenant_id IN (${tenants}))`).catch(() => {});
  for (let pass = 0; pass < 20 && tables.length > 0; pass++) {
    const left: string[] = [];
    for (const table of tables) {
      try {
        await db.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenants})`);
      } catch (err) {
        // Still referenced (a foreign key, or a RESTRICT one): tried again on the next pass.
        if (!['23503', '23001'].includes((err as { code?: string }).code ?? '')) throw err;
        left.push(table);
      }
    }
    tables = left;
  }
  if (tables.length > 0) throw new Error(`Test shops ${pattern} still referenced from: ${tables.join(', ')}`);
  await db.query(`DELETE FROM tenants WHERE name LIKE '${pattern.replace(/'/g, "''")}'`);
}
