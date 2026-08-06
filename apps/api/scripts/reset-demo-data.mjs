/**
 * Reset Demo / Test Data — Production Go-Live Cleanup
 *
 * Uses PostgreSQL's own FK graph to determine the correct delete order
 * automatically — no hardcoded table list, no ordering errors.
 *
 * PRESERVES (never touched):
 *   staff id=1 and id=2, their roles/branch assignments
 *   roles, permissions, role_permissions
 *   branches WITHOUT "test" in name + their locations
 *   system_config
 *   catalog (books, authors, categories, publishers, formats, editions, prices)
 *   inventory table rows (quantity reset to 0)
 *
 * DELETES:
 *   All transactional data (orders, POS, procurement, returns, exchanges,
 *   receivables, customers, loyalty/store-credit, audit_logs, outbox, etc.)
 *   Test branches (name ILIKE '%test%') and their locations/staff
 *
 * USAGE:
 *   node scripts/reset-demo-data.mjs --dry-run    # preview, no writes
 *   node scripts/reset-demo-data.mjs --force      # skip prompt
 *   node scripts/reset-demo-data.mjs              # interactive YES prompt
 */

import pg from 'pg';
import readline from 'readline';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE   = process.argv.includes('--force');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ── Tables we will NEVER delete from ─────────────────────────────────────────
const PRESERVED_TABLES = new Set([
  'staff',
  'staff_branch_roles',
  'staff_locations',
  'refresh_tokens',
  'roles',
  'permissions',
  'role_permissions',
  'branches',
  'locations',
  'system_config',
  'books',
  'authors',
  'categories',
  'publishers',
  'book_authors',
  'book_categories',
  'book_tags',
  'book_formats',
  'book_editions',
  'book_prices',
  'book_branch_prices',
  'inventory',
  // Migration/schema tables
  'pgmigrations',
  'schema_migrations',
]);

// ── Build a topological delete order from the live FK graph ──────────────────
async function buildDeleteOrder(client) {
  // Get all FK edges: child_table references parent_table
  const fkRes = await client.query(`
    SELECT DISTINCT
      kcu.table_name   AS child,
      ccu.table_name   AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = rc.unique_constraint_name
      AND ccu.table_schema = rc.unique_constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND kcu.table_schema = 'public'
  `);

  // Get all public tables
  const tablesRes = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const allTables = tablesRes.rows.map(r => r.table_name);

  // Build adjacency: parent → [children that depend on it]
  const children = new Map();   // parent → Set of children
  const parents  = new Map();   // child  → Set of parents
  for (const t of allTables) { children.set(t, new Set()); parents.set(t, new Set()); }

  for (const { child, parent } of fkRes.rows) {
    if (child === parent) continue; // self-ref, ignore
    children.get(parent)?.add(child);
    parents.get(child)?.add(parent);
  }

  // Kahn's algorithm — topological sort
  // We want delete order = leaves first (tables with no children)
  const inDegree = new Map();
  for (const t of allTables) {
    inDegree.set(t, children.get(t)?.size ?? 0);
  }

  const queue = allTables.filter(t => (children.get(t)?.size ?? 0) === 0);
  const order = [];

  while (queue.length > 0) {
    const node = queue.shift();
    order.push(node);
    for (const parent of (parents.get(node) ?? [])) {
      const c = children.get(parent);
      c.delete(node);
      if (c.size === 0) queue.push(parent);
    }
  }

  // Filter out preserved tables
  return order.filter(t => !PRESERVED_TABLES.has(t));
}

// ── Delete helper ─────────────────────────────────────────────────────────────
async function del(client, table, where, params, label) {
  const sql = where
    ? `DELETE FROM "${table}" WHERE ${where}`
    : `DELETE FROM "${table}"`;
  const r = await client.query(sql, params || []);
  if (r.rowCount > 0) {
    const lbl = (label || table).padEnd(50);
    console.log(`    ✓ ${lbl} ${r.rowCount.toLocaleString()} rows`);
  }
  return r.rowCount ?? 0;
}

function prompt(q) {
  return new Promise(res => {
    if (!process.stdin.isTTY || FORCE) { res('YES'); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, a => { rl.close(); res(a.trim()); });
  });
}

function hr() { console.log('─'.repeat(70)); }

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║           BMS — Production Go-Live Reset                          ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  if (DRY_RUN) console.log('\n  *** DRY-RUN — no changes will be made ***');
  if (FORCE)   console.log('\n  *** FORCE mode — skipping confirmation ***');
  console.log('');

  const client = await pool.connect();
  try {
    // ── Build delete order from live FK graph ───────────────────────────
    console.log('  Analysing FK graph...');
    const deleteOrder = await buildDeleteOrder(client);
    console.log(`  Delete order computed: ${deleteOrder.length} tables\n`);

    // ── Identify test branches and staff ───────────────────────────────
    const testBranchRes = await client.query(
      `SELECT id, name FROM branches WHERE name ILIKE '%test%' ORDER BY name`,
    );
    const bids = testBranchRes.rows.map(r => r.id);

    const testStaffRes = await client.query(
      `SELECT id, username FROM staff WHERE id > 2
         AND (username ILIKE '%test%' OR username ILIKE '%bug%'
           OR username ILIKE 'cat_%'  OR username ILIKE 'profit_%'
           OR username ILIKE 'invcon_%' OR username ILIKE 'fix%admin')
       ORDER BY username`,
    );
    const sids = testStaffRes.rows.map(r => r.id);

    console.log(`  Test branches : ${bids.length}`);
    for (const r of testBranchRes.rows) console.log(`    - ${r.name}  (id=${r.id})`);
    console.log(`  Test staff    : ${sids.length}`);
    for (const r of testStaffRes.rows) console.log(`    - ${r.username}  (id=${r.id})`);

    if (DRY_RUN) {
      console.log('\n  Tables that would be cleared (in order):');
      for (const t of deleteOrder) console.log(`    - ${t}`);
      console.log('\n  DRY-RUN complete. Nothing changed.\n');
      process.exit(0);
    }

    hr();
    const answer = await prompt('  Type YES to confirm full reset: ');
    if (answer !== 'YES') {
      console.log('\n  Aborted. No changes made.\n');
      process.exit(0);
    }

    hr();
    console.log('\n  Deleting in FK-safe order...\n');
    await client.query('BEGIN');

    // ── Delete all transactional tables in topological order ────────────
    for (const table of deleteOrder) {
      await del(client, table);
    }

    // ── Reset inventory quantities to 0 ─────────────────────────────────
    const invRes = await client.query(
      `UPDATE inventory SET quantity = 0, version = version + 1, updated_at = now()`,
    );
    console.log(`\n    ✓ ${'inventory (qty → 0)'.padEnd(50)} ${invRes.rowCount.toLocaleString()} rows`);

    // ── Remove test branches, locations, test staff ──────────────────────
    // At this point all transactional FK dependencies are gone.
    if (bids.length > 0 || sids.length > 0) {
      console.log('\n  [Test branch / staff cleanup]\n');

      if (sids.length > 0) {
        await del(client, 'refresh_tokens',    'staff_id = ANY($1)', [sids], 'refresh_tokens (test staff)');
        await del(client, 'staff_locations',   'staff_id = ANY($1)', [sids], 'staff_locations (test staff)');
        await del(client, 'staff_branch_roles','staff_id = ANY($1)', [sids], 'staff_branch_roles (test staff)');
        await del(client, 'staff',             'id = ANY($1)',        [sids], 'staff (test accounts)');
      }

      if (bids.length > 0) {
        const locRes = await client.query(
          `SELECT id FROM locations WHERE branch_id = ANY($1)`, [bids],
        );
        const lids = locRes.rows.map(r => r.id);
        if (lids.length > 0) {
          await del(client, 'staff_locations', 'location_id = ANY($1)', [lids], 'staff_locations (test locs)');
          await del(client, 'locations',       'id = ANY($1)',           [lids], 'locations (test)');
        }
        await del(client, 'staff_branch_roles','branch_id = ANY($1)', [bids], 'staff_branch_roles (test)');
        await del(client, 'branches',          'id = ANY($1)',          [bids], 'branches (test)');
      }
    }

    await client.query('COMMIT');

    hr();
    console.log('\n  ✓ Reset complete.');
    console.log(`  ${bids.length} test branch(es) removed. All transactional data cleared.`);
    console.log('  Main Branch, catalog, superadmin/admin, config preserved.\n');
    process.exit(0);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n  ✗ FAILED — database rolled back. Error: ${err.message}\n`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
