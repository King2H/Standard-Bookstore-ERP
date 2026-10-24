/**
 * fresh-install.test.ts
 *
 * A fresh install starts with no demo data (owner decisions 1a, 2a, 3a, 4a,
 * 2026-10-24): what it needs to run (Main Branch, the two accounts, a
 * location, the settings) and nothing a shop would have to clean up. Demo
 * data is opt-in, `npm run db:demo`, for an empty shop only (1a), its
 * customers starting with no store credit or points (3a). Main Branch has no
 * made-up address or phone (4a). Shops that already have the demo rows lose
 * the ones never used, audited (2a). Each test names what happened before.
 *
 * The install is a database of its own, migrated and seeded as the server
 * does on its first start.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { ensureAppLogin } from '../db/appRole.js';
import { runChecks } from '../db/checks/run.js';
import { loadDemoData } from '../db/demo.js';
import { ownerDb } from './helpers/ownerDb.js';
import { resolveTestDatabaseUrl, resolveTestMigrationUrl } from './testDatabaseUrl.js';

const NAME = 'bms_freshinstall_test';
const withName = (url: string) => { const u = new URL(url); u.pathname = `/${NAME}`; return u.toString(); };
const ownerUrl = withName(resolveTestMigrationUrl());
const appUrl = withName(resolveTestDatabaseUrl());
const API = resolve(__dirname, '../..');

/** The server's startup seed, run as the server runs it: as the API's user, against the install. */
function startServerSeed() {
  execFileSync('npx', ['tsx', '--eval', "import('./src/db/seed.ts').then((m) => m.ensureSeedData()).then(() => process.exit(0))"], {
    cwd: API, env: { ...process.env, DATABASE_URL: appUrl }, stdio: 'pipe',
  });
}

describe('A fresh install', () => {
  let owner: pg.Client;
  const count = async (sql: string) => Number((await owner.query(sql)).rows[0].n);

  beforeAll(async () => {
    const maintenance = new URL(ownerUrl);
    maintenance.pathname = '/postgres';
    const admin = new pg.Client({ connectionString: maintenance.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${NAME}`);
    await admin.end();
    await runner({ databaseUrl: ownerUrl, dir: resolve(__dirname, '../db/migrations'), direction: 'up', migrationsTable: 'pgmigrations', count: Infinity, log: () => {} });
    await ensureAppLogin(ownerUrl, appUrl);
    startServerSeed();
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
    const maintenance = new URL(ownerUrl);
    maintenance.pathname = '/postgres';
    const admin = new pg.Client({ connectionString: maintenance.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  it('has what it needs to run and no demo data (1a; was: 8 books, 2 suppliers, 3 customers)', async () => {
    expect(await count(`SELECT COUNT(*) AS n FROM branches`)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM staff`)).toBe(2);
    expect(await count(`SELECT COUNT(*) AS n FROM locations`)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM system_config WHERE key = 'base_currency'`)).toBe(1);
    const demo = await owner.query(`
      SELECT (SELECT COUNT(*) FROM books)::int AS books, (SELECT COUNT(*) FROM authors)::int AS authors,
             (SELECT COUNT(*) FROM categories)::int AS categories, (SELECT COUNT(*) FROM publishers)::int AS publishers,
             (SELECT COUNT(*) FROM book_tags)::int AS tags, (SELECT COUNT(*) FROM inventory)::int AS stock_rows,
             (SELECT COUNT(*) FROM suppliers)::int AS suppliers, (SELECT COUNT(*) FROM customers)::int AS customers,
             (SELECT COUNT(*) FROM purchase_orders)::int AS purchase_orders`);
    expect(demo.rows[0]).toEqual({ books: 0, authors: 0, categories: 0, publishers: 0, tags: 0, stock_rows: 0, suppliers: 0, customers: 0, purchase_orders: 0 });
  });

  it('gives Main Branch no made-up address or phone (4a; was: "1 Bookstore Avenue, City", 555-0100)', async () => {
    const branch = (await owner.query(`SELECT name, address, contact_info FROM branches`)).rows[0];
    expect(branch).toEqual({ name: 'Main Branch', address: '', contact_info: {} });
  });

  it('passes the data consistency check', async () => {
    const errors = (await runChecks(owner)).filter((f) => f.check.severity === 'error' && f.count > 0);
    expect(errors.map((f) => f.check.id)).toEqual([]);
  });

  it('loads the demo data on request, for an empty shop, audited, its customers with no store credit or points (1a, 3a; was: ETB 35.00 and 225 points from nowhere)', async () => {
    const loaded = await loadDemoData(owner);
    expect(loaded).toEqual({ books: 8, suppliers: 2, customers: 3 });
    expect(await count(`SELECT COUNT(*) AS n FROM books`)).toBe(8);
    expect(await count(`SELECT COUNT(*) AS n FROM book_authors`)).toBe(8);
    expect(await count(`SELECT COUNT(*) AS n FROM book_tags`)).toBe(16);
    expect(await count(`SELECT COUNT(*) AS n FROM books WHERE publisher_id IS NULL`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM inventory WHERE quantity = 0`)).toBe(8);
    // The codes continue the series: the demo customers the migration removed keep theirs in the audit log.
    expect((await owner.query(`SELECT customer_code FROM customers ORDER BY customer_code`)).rows.map((r) => r.customer_code))
      .toEqual(['CUS-0004', 'CUS-0005', 'CUS-0006']);
    const money = (await owner.query(`
      SELECT (SELECT COALESCE(SUM(balance), 0) FROM store_credit_accounts)::text AS credit,
             (SELECT COALESCE(SUM(points_balance), 0) FROM loyalty_accounts)::text AS points,
             (SELECT COUNT(*) FROM store_credit_accounts)::int AS credit_accounts`)).rows[0];
    expect(money).toEqual({ credit: '0.00', points: '0.00', credit_accounts: 3 });
    const audit = (await owner.query(`SELECT staff_id, staff_role, action, entity_type, meta FROM audit_logs WHERE entity_type = 'demo_data'`)).rows;
    expect(audit).toEqual([{ staff_id: null, staff_role: 'system', action: 'CREATE', entity_type: 'demo_data', meta: expect.objectContaining({ books: 8, suppliers: 2, customers: 3 }) }]);

    await expect(loadDemoData(owner)).rejects.toThrow(/empty shop/);
    expect(await count(`SELECT COUNT(*) AS n FROM books`)).toBe(8);
  });

  it('keeps a deleted book deleted when the server starts again (was: the startup seed put the demo books back)', async () => {
    await owner.query(`DELETE FROM books WHERE isbn = '9780441013593'`);
    startServerSeed();
    expect(await count(`SELECT COUNT(*) AS n FROM books WHERE isbn = '9780441013593'`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM books`)).toBe(7);
  }, 60_000);
});

describe('The migration on a shop that has the demo rows (2a, 4a)', () => {
  it('removes the demo rows never used and clears the made-up branch details, audited; used ones stay', async () => {
    const migration = createRequire(import.meta.url)('../db/migrations/1700000078_no_demo_data.cjs') as {
      up: (pgm: { sql: (s: string) => void }) => void;
    };
    const client = await ownerDb().connect();
    try {
      await client.query('BEGIN');
      const t = (await client.query(`INSERT INTO tenants (name) VALUES ('Demo Rows Test') RETURNING id`)).rows[0].id as number;
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [String(t)]);
      const one = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0].id as number;
      const placeholder = await one(
        `INSERT INTO branches (name, address, contact_info, operating_hours)
         VALUES ('Main Branch', '1 Bookstore Avenue, City', '{"phone":"555-0100","email":"main@bookstore.com"}', '{}') RETURNING id`,
      );
      const real = await one(`INSERT INTO branches (name, address, contact_info, operating_hours) VALUES ('Piassa', 'Piassa, Addis Ababa', '{"phone":"0111"}', '{}') RETURNING id`);
      const loc = await one(`INSERT INTO locations (branch_id, name) VALUES ($1, 'Shelf') RETURNING id`, [placeholder]);
      const staff = await one(`INSERT INTO staff (username, password_hash, full_name) VALUES ('demorows_test_staff', 'x', 'Demo Rows') RETURNING id`);
      // The demo rows as the early migrations made them.
      const pub = await one(`INSERT INTO publishers (name) VALUES ('Chilton Books') RETURNING id`);
      const otherPub = await one(`INSERT INTO publishers (name) VALUES ('Allen & Unwin') RETURNING id`);
      const author = await one(`INSERT INTO authors (name, normalized_name) VALUES ('Frank Herbert', 'frank herbert') RETURNING id`);
      const book = (isbn: string, title: string, publisherId: number) =>
        one(`INSERT INTO books (isbn, title, publisher_id, default_price) VALUES ($1, $2, $3, 10) RETURNING id`, [isbn, title, publisherId]);
      const dune = await book('9780441013593', 'Dune', pub);
      const lotr = await book('9780618640157', 'The Lord of the Rings', otherPub);
      await client.query(`INSERT INTO book_authors (book_id, author_id, sort_order) VALUES ($1, $2, 0)`, [dune, author]);
      await client.query(`INSERT INTO book_tags (book_id, tag) VALUES ($1, 'space-opera')`, [dune]);
      await client.query(`INSERT INTO inventory (book_id, location_id, quantity) VALUES ($1, $2, 0), ($3, $2, 0)`, [dune, loc, lotr]);
      // The Lord of the Rings was sold from: its stock moved.
      await client.query(
        `INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta, reason_code, staff_id) VALUES ($1, $2, 0, 3, 3, 'initial', $3)`,
        [lotr, loc, staff],
      );
      const supplier = (name: string) => one(`INSERT INTO suppliers (name, contact_info) VALUES ($1, '{}') RETURNING id`, [name]);
      await supplier('Book Distributors Inc');
      const ordered = await supplier('Oxford University Press Direct');
      await client.query(`INSERT INTO purchase_orders (branch_id, supplier_id, created_by, currency) VALUES ($1, $2, $3, 'ETB')`, [real, ordered, staff]);
      const customer = async (code: string, name: string, credit: number, points: number) => {
        const id = await one(`INSERT INTO customers (branch_id, customer_code, full_name) VALUES ($1, $2, $3) RETURNING id`, [placeholder, code, name]);
        await client.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, $2)`, [id, credit]);
        await client.query(`INSERT INTO loyalty_accounts (customer_id, points_balance, lifetime_points) VALUES ($1, $2, $2)`, [id, points]);
        return id;
      };
      const alice = await customer('CUS-0001', 'Alice Johnson', 25, 150);
      const bob = await customer('CUS-0002', 'Bob Smith', 0, 0);
      // Bob was edited in Customers, so he is in use.
      await client.query(
        `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, meta) VALUES ($1, 'Admin', 'UPDATE', 'customer', $2, '{}')`,
        [staff, String(bob)],
      );

      const statements: string[] = [];
      migration.up({ sql: (q) => statements.push(q) });
      for (const q of statements) await client.query(q);
      for (const q of statements) await client.query(q); // a second run changes nothing

      const left = async (sql: string) => (await client.query(sql, [t])).rows.map((r) => Object.values(r)[0]);
      expect(await left(`SELECT title FROM books WHERE tenant_id = $1 ORDER BY id`)).toEqual(['The Lord of the Rings']);
      expect(await left(`SELECT name FROM authors WHERE tenant_id = $1`)).toEqual([]);
      expect(await left(`SELECT name FROM publishers WHERE tenant_id = $1 ORDER BY id`)).toEqual(['Allen & Unwin']);
      expect(await left(`SELECT name FROM suppliers WHERE tenant_id = $1`)).toEqual(['Oxford University Press Direct']);
      expect(await left(`SELECT customer_code FROM customers WHERE tenant_id = $1`)).toEqual(['CUS-0002']);
      expect((await client.query(`SELECT 1 FROM store_credit_accounts WHERE customer_id = $1`, [alice])).rows).toEqual([]);
      const branches = (await client.query(`SELECT id, address, contact_info FROM branches WHERE tenant_id = $1 ORDER BY id`, [t])).rows;
      expect(branches).toEqual([
        { id: placeholder, address: '', contact_info: {} },
        { id: real, address: 'Piassa, Addis Ababa', contact_info: { phone: '0111' } },
      ]);

      const audit = (await client.query(
        `SELECT action, entity_type, entity_id, meta FROM audit_logs WHERE tenant_id = $1 AND staff_role = 'system' ORDER BY id`, [t],
      )).rows;
      expect(audit).toEqual(expect.arrayContaining([
        { action: 'DELETE', entity_type: 'book', entity_id: String(dune), meta: expect.objectContaining({ isbn: '9780441013593', title: 'Dune' }) },
        { action: 'DELETE', entity_type: 'customer', entity_id: String(alice), meta: expect.objectContaining({ customerCode: 'CUS-0001', storeCredit: '25.00', loyaltyPoints: '150.00' }) },
        { action: 'DELETE', entity_type: 'supplier', entity_id: expect.any(String), meta: expect.objectContaining({ name: 'Book Distributors Inc' }) },
        { action: 'DELETE', entity_type: 'author', entity_id: String(author), meta: expect.objectContaining({ name: 'Frank Herbert' }) },
        { action: 'DELETE', entity_type: 'publisher', entity_id: String(pub), meta: expect.objectContaining({ name: 'Chilton Books' }) },
        { action: 'UPDATE', entity_type: 'branch', entity_id: String(placeholder), meta: expect.objectContaining({ previousAddress: '1 Bookstore Avenue, City' }) },
      ]));
      expect(audit).toHaveLength(6);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
