// #246 part 5 (owner decisions 1a–4a, 2026-11-07): the v1 shop's lists come
// over to v2 from a copy of its database. One command loads the copy into a
// temporary database and writes the five files of the Import / Export page
// (catalog, opening stock, customers, customer balances, supplier balances),
// which are then imported there, with the same checks. Customer contacts are
// encrypted with v1's key: the key is required, and must open every one.
// What the shop owes a supplier is worked out as v1 did (received, less paid,
// less credit notes). Before, a v1 shop could bring nothing over.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import request from 'supertest';
import { ImportReportSchema, ImportResultSchema } from '@bms/shared';
import { checkColumnKey, copyKind, databaseKind } from '../modules/imports/v1Export.policy.js';
import { exportV1Shop, type V1Export } from '../modules/imports/v1Export.service.js';
import { getTestApp } from './helpers/testApp.js';
import { ownerDb } from './helpers/ownerDb.js';
import { DEFAULT_ADMIN_PASSWORD_HASH } from '../db/seed.js';

/** v1's format (release/1.x src/lib/encryption.ts): base64 of IV (12), tag (16), ciphertext. */
function v1Encrypt(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

const KEY = randomBytes(32).toString('hex');
const PREFIX = 'v1imp_test_';
const TENANT = 'V1 Import Test';
const PASSWORD = 'Admin@1234'; // DEFAULT_ADMIN_PASSWORD_HASH

describe('Import from a v1 shop (#246 part 5)', () => {
  describe('the database the copy holds', () => {
    it('is v1 up to its last migration (50), without tenants', () => {
      expect(databaseKind({ tables: ['pgmigrations', 'customers', 'books'], lastMigration: '1700000050_pos_payment_mobile' })).toBe('v1');
      expect(databaseKind({ tables: ['pgmigrations', 'customers'], lastMigration: '1700000031_seed_initial_data' })).toBe('v1');
    });
    it('is v2 past migration 50, or with tenants: a v2 backup is restored, not imported', () => {
      expect(databaseKind({ tables: ['pgmigrations', 'customers'], lastMigration: '1700000052_customer_contacts_encrypted_only' })).toBe('v2');
      expect(databaseKind({ tables: ['pgmigrations', 'tenants'], lastMigration: '1700000050_pos_payment_mobile' })).toBe('v2');
    });
    it('is empty, or something else without the bookstore\'s migrations', () => {
      expect(databaseKind({ tables: [], lastMigration: null })).toBe('empty');
      expect(databaseKind({ tables: ['orders'], lastMigration: null })).toBe('other');
    });
  });

  describe('the copy given', () => {
    const head = (text: string | Buffer, at = 0) => { const b = Buffer.alloc(512); Buffer.from(text).copy(b, at); return b; };
    it('is read from what it holds, not its name: pg_dump custom, tar or plain SQL, or any of them gzipped', () => {
      expect(copyKind(head('PGDMP\x01\x10'))).toBe('custom');
      expect(copyKind(head('ustar', 257))).toBe('tar');
      expect(copyKind(head('--\n-- PostgreSQL database dump\n--\n'))).toBe('sql');
      expect(copyKind(head(Buffer.from([0x1f, 0x8b, 0x08])))).toBe('gzip');
    });
    it('is refused when it is none of them', () => {
      expect(copyKind(head('PK\x03\x04'))).toBe('unknown');
      expect(copyKind(head('Name,Phone\nAlmaz,0911'))).toBe('unknown');
    });
  });

  describe('the v1 key', () => {
    const values = [v1Encrypt('+251911000111', KEY), v1Encrypt('almaz@example.et', KEY)];
    it('opens every value with the v1 key, none with another', () => {
      expect(checkColumnKey(values, KEY)).toEqual({ checked: 2, unreadable: 0 });
      expect(checkColumnKey(values, randomBytes(32).toString('hex'))).toEqual({ checked: 2, unreadable: 2 });
    });
    it('is 64 hexadecimal characters', () => {
      expect(() => checkColumnKey(values, 'not-a-key')).toThrow(/64 hexadecimal characters/);
    });
  });

  describe('a v1 shop', () => {
    const v1Name = 'bms_v1import_test';
    let v1: pg.Client;
    let files: V1Export;
    const file = (prefix: string) => files.files.find((f) => f.name.startsWith(prefix))!;
    const lines = (prefix: string) => file(prefix).csv.replace(/^\uFEFF/, '').split('\r\n');

    beforeAll(async () => {
      const owner = ownerDb();
      await owner.query(`DROP DATABASE IF EXISTS ${v1Name}`);
      await owner.query(`CREATE DATABASE ${v1Name}`);
      const url = new URL(process.env.MIGRATION_DATABASE_URL!);
      url.pathname = `/${v1Name}`;
      v1 = new pg.Client({ connectionString: url.toString() });
      await v1.connect();
      await v1.query(readFileSync(new URL('./fixtures/v1-schema.sql', import.meta.url), 'utf8'));
      const enc = (s: string) => v1Encrypt(s, KEY);
      await v1.query(`
        INSERT INTO pgmigrations (name, run_on) VALUES ('1700000031_seed_initial_data', now()), ('1700000050_pos_payment_mobile', now());
        INSERT INTO branches (id, name, address, contact_info, operating_hours) VALUES (1, 'Main Branch', 'Bole', '{}', '{}');
        INSERT INTO locations (id, branch_id, name) VALUES (1, 1, 'Main Floor'), (2, 1, 'Back Room');
        INSERT INTO book_formats (id, code, label, sort_order) VALUES
          (1, 'softcover', 'Softcover', 1), (2, 'hardcover', 'Hardcover', 2), (3, 'leather_bound', 'Leather Bound', 3);
        INSERT INTO publishers (id, name) VALUES (1, 'Kuraz');
        INSERT INTO authors (id, name, normalized_name) VALUES (1, 'Haddis Alemayehu', 'haddis alemayehu'), (2, 'Bealu Girma', 'bealu girma');
        INSERT INTO categories (id, name, normalized_name) VALUES (1, 'Fiction', 'fiction'), (2, 'Amharic', 'amharic');
        INSERT INTO books (id, isbn, sku, title, genre, publisher, publisher_id, format, format_id, language, default_price, status) VALUES
          (1, '9780306406157', NULL, 'Fikir Eske Mekabir', 'Novel', NULL, 1, 'Hardcover', 2, 'Amharic', 450, 'ACTIVE'),
          (2, '9780140449136', NULL, 'Oromay', 'Novel', 'Mega', NULL, 'Paperback', NULL, 'Amharic', 300, 'ACTIVE'),
          (3, 'SKU-MAP-01', 'MAP-01', 'Map of Addis', NULL, NULL, NULL, NULL, NULL, NULL, 50, 'ACTIVE'),
          (4, '9780143039433', NULL, 'Archived, no stock', NULL, NULL, NULL, NULL, NULL, NULL, 10, 'ARCHIVED'),
          (5, '9781861972712', NULL, 'Inactive, in stock', NULL, NULL, NULL, NULL, NULL, NULL, 99.5, 'INACTIVE');
        INSERT INTO book_authors (book_id, author_id, sort_order) VALUES (1, 1, 0), (2, 2, 0);
        INSERT INTO book_categories (book_id, category_id) VALUES (1, 1), (1, 2);
        INSERT INTO inventory (book_id, location_id, quantity, reorder_point, damaged_quantity, average_cost) VALUES
          (1, 1, 10, 3, 0, 200.5), (1, 2, 2, 0, 0, 0), (2, 1, 5, 2, 1, 120.12345), (3, 1, 0, 5, 0, 10), (5, 1, 3, 0, 0, 80);
        INSERT INTO customers (id, customer_code, full_name, phone, email, address, city, status, phone_encrypted, email_encrypted) VALUES
          (1, 'CUS-0001', 'Abebe Kebede', '+251911000001', NULL, 'Piassa', 'Addis Ababa', 'ACTIVE', NULL, NULL),
          (2, 'CUS-0002', 'Almaz Tesfaye', '+251911000111', 'almaz@example.et', NULL, NULL, 'ACTIVE', '${enc('+251911000111')}', '${enc('almaz@example.et')}'),
          (3, 'CUS-0003', 'Hana Girma', NULL, NULL, NULL, NULL, 'INACTIVE', NULL, '${enc('hana@example.et')}'),
          (4, 'CUS-0004', 'Archived, nothing owed', '+251911000444', NULL, NULL, NULL, 'ARCHIVED', NULL, NULL),
          (5, 'CUS-0005', 'Archived, with credit', NULL, NULL, NULL, NULL, 'ARCHIVED', NULL, NULL);
        INSERT INTO loyalty_accounts (customer_id, points_balance, lifetime_points) VALUES (2, 120.5, 300), (1, 0, 10);
        INSERT INTO store_credit_accounts (customer_id, balance) VALUES (5, 75), (2, 0);
        INSERT INTO receivables (source_type, source_ref_id, source_entity_id, customer_id, branch_id, original_amount, outstanding_amount, currency, due_date, status) VALUES
          ('order', 'ORD-1', 1, 1, 1, 300, 300, 'ETB', '2026-12-01', 'Pending'),
          ('order', 'ORD-2', 2, 1, 1, 500, 200, 'ETB', '2026-11-20', 'PartiallyPaid'),
          ('order', 'ORD-3', 3, 1, 1, 100, 0, 'ETB', '2026-10-01', 'Settled'),
          ('pos', 'POS-1', 4, 3, 1, 150, 150, 'ETB', NULL, 'Overdue');
        INSERT INTO suppliers (id, name, contact_info, supplier_type, status) VALUES
          (1, 'Kuraz Distributors', '{"phone": "+251111234567", "email": "orders@kuraz.et"}', 'distributor', 'ACTIVE'),
          (2, 'Overpaid Ltd', '{}', 'distributor', 'ACTIVE');
        INSERT INTO purchase_orders (id, branch_id, supplier_id, status, total_amount, currency, created_by) VALUES
          (1, 1, 1, 'received', 2000, 'ETB', 1), (2, 1, 1, 'cancelled', 900, 'ETB', 1), (3, 1, 2, 'received', 100, 'ETB', 1);
        INSERT INTO po_line_items (po_id, book_id, quantity, unit_cost, received_quantity) VALUES
          (1, 1, 10, 200, 10), (2, 2, 3, 300, 0), (3, 2, 1, 100, 1);
        INSERT INTO supplier_payments (po_id, branch_id, supplier_id, amount, payment_method, source, created_by) VALUES
          (1, 1, 1, 500, 'cash', 'cash_drawer', 1), (3, 1, 2, 150, 'cash', 'cash_drawer', 1);
        INSERT INTO supplier_credit_notes (po_id, supplier_id, branch_id, amount, reason, created_by) VALUES (1, 1, 1, 100, 'damaged copies', 1);
      `);
      files = await exportV1Shop(v1, KEY);
    });

    afterAll(async () => {
      await v1?.end();
      const db = ownerDb();
      await db.query(`DROP DATABASE IF EXISTS ${v1Name}`);
      const tenants = `SELECT id FROM tenants WHERE name = '${TENANT}'`;
      await db.query(`DELETE FROM refresh_tokens WHERE session_id IN (SELECT id FROM staff_sessions WHERE tenant_id IN (${tenants}))`);
      for (const table of [
        'audit_logs', 'outbox', 'notification_reads', 'notifications', 'financial_transactions', 'supplier_payments', 'po_line_items', 'purchase_orders',
        'receivables', 'store_credit_history', 'store_credit_accounts', 'loyalty_history', 'loyalty_accounts', 'customers', 'inventory_history', 'inventory',
        'book_branch_prices', 'book_authors', 'book_categories', 'books', 'book_formats', 'authors', 'categories', 'publishers', 'document_counters', 'suppliers',
        'system_config', 'staff_branch_roles', 'staff_sessions', 'staff', 'locations', 'branches',
      ]) {
        await db.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenants})`);
      }
      await db.query(`DELETE FROM tenants WHERE name = '${TENANT}'`);
    });

    it('refuses a key that does not open the contacts, saying how many', async () => {
      await expect(exportV1Shop(v1, randomBytes(32).toString('hex'))).rejects.toThrow(/does not open 3 of the 3 encrypted contacts/);
    });

    it('refuses a database that is not v1', async () => {
      const v2 = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
      await v2.connect();
      try {
        await expect(exportV1Shop(v2, KEY)).rejects.toThrow(/v2 database: restore a v2 backup/);
      } finally {
        await v2.end();
      }
    });

    it('writes the books that are not archived, and any in stock, in the catalog file', () => {
      expect(lines('1-catalog')).toEqual([
        'ISBN,SKU,Title,Authors,Publisher,Categories,Format,Language,Price',
        '9780306406157,,Fikir Eske Mekabir,Haddis Alemayehu,Kuraz,Fiction; Amharic,Hardcover,Amharic,450.00',
        '9780140449136,,Oromay,Bealu Girma,Mega,Novel,,Amharic,300.00',
        'SKU-MAP-01,MAP-01,Map of Addis,,,,,,50.00',
        '9781861972712,,"Inactive, in stock",,,,,,99.50',
      ]);
      expect(files.summary.join('\n')).toMatch(/1 book archived in v1, with no stock, is left out/);
      // A v1 format v2 does not have is left empty, and said.
      expect(files.summary.join('\n')).toMatch(/Format "Paperback" \(1 book\) is not one of v2's formats/);
    });

    it('writes the stock at each location, at its v1 average cost to the cent', () => {
      expect(lines('2-opening-stock')).toEqual([
        'ISBN,Title,Location,Quantity,Unit Cost,Reorder Point',
        '9780306406157,Fikir Eske Mekabir,Main Floor,10,200.50,3',
        '9780306406157,Fikir Eske Mekabir,Back Room,2,0.00,0',
        '9780140449136,Oromay,Main Floor,5,120.12,2',
        '9781861972712,"Inactive, in stock",Main Floor,3,80.00,0',
      ]);
      const summary = files.summary.join('\n');
      expect(summary).toMatch(/Locations: Back Room, Main Floor/);
      expect(summary).toMatch(/1 line at cost 0/);
      expect(summary).toMatch(/1 damaged copy is not brought over/);
    });

    it('writes customers with their contacts opened with the v1 key, leaving out archived ones with nothing to carry', () => {
      expect(lines('3-customers')).toEqual([
        'Code,Name,Phone,Email,Address,City',
        "CUS-0001,Abebe Kebede,'+251911000001,,Piassa,Addis Ababa",
        "CUS-0002,Almaz Tesfaye,'+251911000111,almaz@example.et,,",
        'CUS-0003,Hana Girma,,hana@example.et,,',
        'CUS-0005,"Archived, with credit",,,,',
      ]);
      expect(files.summary.join('\n')).toMatch(/phones and emails in clear/);
    });

    it('writes what each customer owes, with the earliest due date, their store credit and whole points', () => {
      const today = new Date().toISOString().slice(0, 10);
      expect(lines('4-customer-balances')).toEqual([
        'Code,Phone,Email,Amount Owed,Due Date,Store Credit,Loyalty Points',
        'CUS-0001,,,500.00,2026-11-20,,',
        'CUS-0002,,,,,,120',
        `CUS-0003,,,150.00,${today},,`,
        'CUS-0005,,,,,75.00,',
      ]);
      const summary = files.summary.join('\n');
      expect(summary).toMatch(/CUS-0003 had no due date in v1/);
      expect(summary).toMatch(/CUS-0002: 120\.5 points in v1, 120 here/);
    });

    it('writes what the shop owes each supplier as v1 worked it out, and names a supplier it paid more than it received', () => {
      expect(lines('5-supplier-balances')).toEqual([
        'Supplier,Phone,Email,Amount Owed',
        "Kuraz Distributors,'+251111234567,orders@kuraz.et,1400.00",
      ]);
      expect(files.summary.join('\n')).toMatch(/Overpaid Ltd: the shop paid 50\.00 more than it received/);
    });

    it('passes every check of the Import / Export page, and comes into a new shop whole', async () => {
      const api = () => request(getTestApp());
      const db = ownerDb();
      const tenant = (await db.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [TENANT])).rows[0].id;
      const branch = (await db.query(
        `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, 'Main Branch', '-', '{}', '{}') RETURNING id`, [tenant],
      )).rows[0].id;
      await db.query(`INSERT INTO locations (tenant_id, branch_id, name) VALUES ($1, $2, 'Main Floor'), ($1, $2, 'Back Room')`, [tenant, branch]);
      await db.query(`INSERT INTO system_config (tenant_id, key, value, updated_by) VALUES ($1, 'base_currency', '"ETB"', 1)`, [tenant]);
      // The formats every new shop starts with.
      await db.query(`INSERT INTO book_formats (tenant_id, code, label, sort_order) VALUES
        ($1, 'softcover', 'Softcover', 1), ($1, 'hardcover', 'Hardcover', 2), ($1, 'leather_bound', 'Leather Bound', 3)`, [tenant]);
      const admin = (await db.query(
        `INSERT INTO staff (tenant_id, username, password_hash, full_name, is_active, must_change_password) VALUES ($1, $2, $3, 'Admin', true, false) RETURNING id`,
        [tenant, `${PREFIX}admin`, DEFAULT_ADMIN_PASSWORD_HASH],
      )).rows[0].id;
      await db.query(`INSERT INTO staff_branch_roles (tenant_id, staff_id, branch_id, role) VALUES ($1, $2, $3, 'Admin')`, [tenant, admin, branch]);
      const login = await api().post('/api/v1/auth/login').send({ username: `${PREFIX}admin`, password: PASSWORD, branchId: branch });
      expect(login.status).toBe(200);
      const token = login.body.accessToken as string;

      const kinds: Array<[string, string]> = [
        ['1-catalog', 'catalog'], ['2-opening-stock', 'opening-stock'], ['3-customers', 'customers'],
        ['4-customer-balances', 'customer-balances'], ['5-supplier-balances', 'supplier-balances'],
      ];
      for (const [prefix, kind] of kinds) {
        const body = { csv: file(prefix).csv, fileName: file(prefix).name };
        const check = await api().post(`/api/v1/imports/${kind}/check`).set('Authorization', `Bearer ${token}`).send(body);
        expect(check.status, `${kind} check`).toBe(200);
        expect(ImportReportSchema.parse(check.body).errors, `${kind} errors`).toEqual([]);
        const saved = await api().post(`/api/v1/imports/${kind}`).set('Authorization', `Bearer ${token}`).send(body);
        expect(saved.status, `${kind} import`).toBe(200);
        expect(ImportResultSchema.parse(saved.body).skipped).toBe(0);
      }

      const one = async (sql: string) => (await db.query(sql, [tenant])).rows[0];
      expect(await one(`SELECT count(*)::int AS n FROM books WHERE tenant_id = $1`)).toEqual({ n: 4 });
      expect(await one(`SELECT sum(quantity)::int AS copies, sum(quantity * average_cost)::numeric(14,2)::text AS value FROM inventory WHERE tenant_id = $1`))
        .toEqual({ copies: 20, value: '2845.60' });
      expect((await db.query(`SELECT customer_code FROM customers WHERE tenant_id = $1 ORDER BY customer_code`, [tenant])).rows.map((r) => r.customer_code))
        .toEqual(['CUS-0001', 'CUS-0002', 'CUS-0003', 'CUS-0005']);
      expect(await one(`SELECT sum(outstanding_amount)::text AS owed FROM receivables WHERE tenant_id = $1`)).toEqual({ owed: '650.00' });
      expect(await one(`SELECT sum(balance)::text AS credit FROM store_credit_accounts WHERE tenant_id = $1`)).toEqual({ credit: '75.00' });
      expect(await one(`SELECT sum(points_balance)::int AS points FROM loyalty_accounts WHERE tenant_id = $1`)).toEqual({ points: 120 });
      expect(await one(`SELECT total_amount::text AS owed FROM purchase_orders WHERE tenant_id = $1 AND kind = 'opening_balance'`)).toEqual({ owed: '1400.00' });
    });
  });
});
