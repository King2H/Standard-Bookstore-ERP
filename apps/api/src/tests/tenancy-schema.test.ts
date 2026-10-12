import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../db/index.js';

// #13, part 1: every business row belongs to a tenant (ADR-0003, owner
// decisions 1a and 2a). These tests keep it that way as tables are added.

/** Tables that belong to no tenant: the tenants themselves, the migration log, and refresh tokens (their session has the tenant). */
const GLOBAL_TABLES = ['pgmigrations', 'refresh_tokens', 'tenants'];

/**
 * Unique keys on tenant tables that neither lead with tenant_id nor rest on an
 * id or a reference to a tenant's row, so they are unique across tenants.
 */
const GLOBAL_UNIQUES = [
  // Usernames are unique across tenants: sign-in finds the account first (3a).
  'staff.staff_username_key',
  'staff.staff_username_lower_key',
  // A receivable or reconciliation row per source document; the document ids
  // come from one sequence across tenants.
  'receivables.receivables_source_unique',
  'bank_reconciliation.bank_reconciliation_source_key',
];

const TENANT_PREFIX = 'Tenancy Schema Test ';

describe('Tenancy schema', () => {
  let otherTenant: number;

  beforeAll(async () => {
    await cleanUp();
    otherTenant = (await db.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`${TENANT_PREFIX}B`])).rows[0].id;
  });

  afterAll(cleanUp);

  async function cleanUp() {
    const tenants = `SELECT id FROM tenants WHERE name LIKE '${TENANT_PREFIX}%'`;
    for (const table of ['books', 'branches', 'document_counters', 'staff']) {
      await db.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenants})`);
    }
    await db.query(`DELETE FROM tenants WHERE name LIKE '${TENANT_PREFIX}%'`);
  }

  it('has tenant 1, "Default", owning the existing data', async () => {
    expect((await db.query(`SELECT id, name, status FROM tenants WHERE id = 1`)).rows).toEqual([{ id: 1, name: 'Default', status: 'active' }]);
    expect((await db.query(`SELECT tenant_id FROM branches WHERE id = 1`)).rows).toEqual([{ tenant_id: 1 }]);
  });

  it('gives every table but the global ones a required tenant_id referencing tenants', async () => {
    const { rows } = await db.query<{ table_name: string; has_column: boolean; not_null: boolean; references_tenants: boolean }>(`
      SELECT c.relname AS table_name,
             a.attname IS NOT NULL AS has_column,
             COALESCE(a.attnotnull, false) AS not_null,
             EXISTS (
               SELECT 1 FROM pg_constraint f
               WHERE f.conrelid = c.oid AND f.contype = 'f' AND f.confrelid = 'tenants'::regclass AND f.conkey = ARRAY[a.attnum]
             ) AS references_tenants
      FROM pg_class c
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND c.relname <> ALL ($1)
      ORDER BY c.relname`, [GLOBAL_TABLES]);
    expect(rows.length).toBeGreaterThan(60);
    expect(rows.filter((r) => !(r.has_column && r.not_null && r.references_tenants)).map((r) => r.table_name)).toEqual([]);
  });

  it('keeps no business identifier unique across tenants, except the listed ones', async () => {
    const { rows } = await db.query<{ key: string }>(`
      SELECT c.relname || '.' || ix.relname AS key
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_class ix ON ix.oid = i.indexrelid
      WHERE i.indisunique
        AND c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND c.relname <> ALL ($1)
        -- Not led by tenant_id, and no column is an id or a reference to another row.
        AND NOT EXISTS (
          SELECT 1 FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n)
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
          WHERE (a.attname = 'tenant_id' AND k.n = 1)
             OR a.attname = 'id'
             OR EXISTS (SELECT 1 FROM pg_constraint f WHERE f.conrelid = c.oid AND f.contype = 'f' AND a.attnum = ANY (f.conkey))
        )
      ORDER BY 1`, [GLOBAL_TABLES]);
    expect(rows.map((r) => r.key)).toEqual([...GLOBAL_UNIQUES].sort());
  });

  it('allows the same branch name, ISBN and document counter in another tenant, but not twice in one', async () => {
    const { rows: [main] } = await db.query(`SELECT name FROM branches WHERE id = 1`);
    const { rows: [book] } = await db.query(`SELECT isbn, title FROM books WHERE isbn IS NOT NULL ORDER BY id LIMIT 1`);

    await db.query(
      `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, $2, '-', '{}', '{}')`,
      [otherTenant, main.name],
    );
    await db.query(`INSERT INTO books (tenant_id, isbn, title) VALUES ($1, $2, $3)`, [otherTenant, book.isbn, book.title]);
    await db.query(`INSERT INTO document_counters (tenant_id, series, period, last_value) VALUES ($1, 'ORD', '20260101', 7)`, [otherTenant]);

    await expect(db.query(
      `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, $2, '-', '{}', '{}')`,
      [otherTenant, main.name],
    )).rejects.toMatchObject({ code: '23505' });
    await expect(db.query(`INSERT INTO books (tenant_id, isbn, title) VALUES ($1, $2, $3)`, [otherTenant, book.isbn, book.title]))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('keeps usernames unique across tenants', async () => {
    const { rows: [admin] } = await db.query(`SELECT username FROM staff WHERE id = 1`);
    await expect(db.query(
      `INSERT INTO staff (tenant_id, username, password_hash, full_name) VALUES ($1, $2, 'x', 'Other tenant')`,
      [otherTenant, admin.username.toUpperCase()],
    )).rejects.toMatchObject({ code: '23505' });
  });
});
