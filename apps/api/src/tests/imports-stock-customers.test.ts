// #246 (owner decisions 1a–4a, 2026-11-07), part 2: a shop starts with its
// stock and its customers from files. Opening stock is a quantity and unit
// cost per book and location, recorded as opening stock at that cost, by
// those who hold MANAGE_INVENTORY, in their branch and their locations; a
// book with stock history at a location is corrected by a stock count, never
// by a second opening stock, so a file imported again adds nothing. A cost of
// 0 comes in at 0 and is listed for Revalue (4a). Customers are matched by
// code, phone or email; Admin and Manager import them, and their export,
// with contacts in clear, is audited. Before, there was neither.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { CUSTOMER_IMPORT_COLUMNS, ImportReportSchema, ImportResultSchema, OPENING_STOCK_IMPORT_COLUMNS } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'stockimp_test_';
const BRANCH_PREFIX = 'Stock Import ';
const NAME = 'Stockimp';
const ISBN_A = '9780306406157';
const ISBN_B = '9780198526636';
const STOCK = 'ISBN,Title,Location,Quantity,Unit Cost,Reorder Point';
const CUSTOMERS = 'Code,Name,Phone,Email,Address,City';

describe('Opening stock and customers import and export (#246)', () => {
  let branch: number;
  let front: number;
  let back: number;
  let admin: string;
  let manager: string;
  let clerk: string;
  let limitedClerk: string;
  let sales: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = admin) => r.set('Authorization', `Bearer ${token}`);
  const post = (path: string, csv: string, token = admin, onlyValid = false) =>
    as(api().post(`/api/v1/imports/${path}`), token).send({ csv, fileName: `${path}.csv`, onlyValid });
  const level = async (isbn: string, location: number) => (await db.query(
    `SELECT i.quantity, i.average_cost::text AS cost, i.reorder_point FROM inventory i JOIN books b ON b.id = i.book_id WHERE b.isbn = $1 AND i.location_id = $2`,
    [isbn, location],
  )).rows[0];
  const errorsByLine = (body: unknown) => Object.fromEntries(ImportReportSchema.parse(body).errors.map((e) => [e.line, e.messages.join(' | ')]));

  async function cleanUp() {
    const books = (await db.query(`SELECT id FROM books WHERE title LIKE $1`, [`${NAME}%`])).rows.map((r) => r.id);
    if (books.length) {
      for (const table of ['inventory_history', 'inventory', 'book_authors', 'book_categories', 'book_tags', 'book_branch_prices', 'book_edit_history']) {
        await db.query(`DELETE FROM ${table} WHERE book_id = ANY($1)`, [books]);
      }
      await db.query(`DELETE FROM books WHERE id = ANY($1)`, [books]);
    }
    const customers = (await db.query(`SELECT id FROM customers WHERE full_name LIKE $1`, [`${NAME}%`])).rows.map((r) => r.id);
    if (customers.length) {
      for (const table of ['loyalty_accounts', 'store_credit_accounts', 'customer_group_membership']) {
        await db.query(`DELETE FROM ${table} WHERE customer_id = ANY($1)`, [customers]);
      }
      await db.query(`DELETE FROM customers WHERE id = ANY($1)`, [customers]);
    }
    await db.query(`DELETE FROM audit_logs WHERE entity_type = 'data_import' AND meta->>'fileName' IN ('opening-stock.csv', 'customers.csv')`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branch = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    const other = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    front = (await db.query(`INSERT INTO locations (branch_id, name) VALUES ($1, 'Front') RETURNING id`, [branch])).rows[0].id;
    back = (await db.query(`INSERT INTO locations (branch_id, name) VALUES ($1, 'Back Store') RETURNING id`, [branch])).rows[0].id;
    await db.query(`INSERT INTO locations (branch_id, name) VALUES ($1, 'Elsewhere') RETURNING id`, [other]);
    admin = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId: branch })).token;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId: branch })).token;
    clerk = (await createTestStaff({ username: `${STAFF_PREFIX}clerk`, role: 'Stock_Clerk', branchId: branch })).token;
    const limited = await createTestStaff({ username: `${STAFF_PREFIX}limited`, role: 'Stock_Clerk', branchId: branch });
    await db.query(`INSERT INTO staff_locations (staff_id, location_id) VALUES ($1, $2)`, [limited.staffId, front]);
    limitedClerk = limited.token;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId: branch })).token;
    const catalog = await post('catalog', [
      'ISBN,SKU,Title,Authors,Publisher,Categories,Format,Language,Price',
      `${ISBN_A},,${NAME} Book A,,,,,,100`,
      `${ISBN_B},,${NAME} Book B,,,,,,80`,
      `,${NAME}-SKU-1,${NAME} Book C,,,,,,20`,
    ].join('\r\n'));
    expect(catalog.status).toBe(200);
  });

  afterAll(cleanUp);

  describe('opening stock', () => {
    it('gives its template, and only staff holding MANAGE_INVENTORY import it', async () => {
      const res = await as(api().get('/api/v1/imports/opening-stock/template'), clerk);
      expect(res.status).toBe(200);
      expect(res.text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(OPENING_STOCK_IMPORT_COLUMNS.join(','));
      expect(OPENING_STOCK_IMPORT_COLUMNS.join(',')).toBe(STOCK);
      expect((await post('opening-stock/check', `${STOCK}\r\n${ISBN_A},,Front,1,5,`, sales)).status).toBe(403);
      expect((await as(api().get('/api/v1/exports/opening-stock'), sales)).status).toBe(403);
    });

    it('checks every row: the book, a location of this branch, the quantity, the cost and the reorder point', async () => {
      const csv = [
        STOCK,
        `${ISBN_A},${NAME} Book A,Front,10,45.50,3`,
        `9781234567897,,Front,1,5,`,
        `${ISBN_B},,Elsewhere,1,5,`,
        `${ISBN_B},,Front,-2,5,`,
        `${ISBN_B},,Front,4,,`,
        `${ISBN_B},,Front,4,cheap,`,
        `${ISBN_B},,Front,4,5,two`,
        `${ISBN_A},,front,2,5,`,
        `SKU-${NAME}-SKU-1,,Back Store,6,0,`,
      ].join('\r\n');
      const res = await post('opening-stock/check', csv, manager);
      expect(res.status).toBe(200);
      expect(ImportReportSchema.parse(res.body)).toMatchObject({ kind: 'opening-stock', rows: 9, valid: 2, toCreate: 2 });
      const byLine = errorsByLine(res.body);
      expect(byLine[3]).toMatch(/No book with ISBN 9781234567897: import the catalog first/);
      expect(byLine[4]).toMatch(/No location 'Elsewhere' in this branch/);
      expect(byLine[5]).toMatch(/Quantity/);
      expect(byLine[6]).toMatch(/Unit Cost/);
      expect(byLine[7]).toMatch(/Unit Cost/);
      expect(byLine[8]).toMatch(/Reorder Point/);
      expect(byLine[9]).toMatch(/line 2/);
      // A cost of 0 is allowed, and listed for Revalue (4a).
      expect(ImportReportSchema.parse(res.body).notices).toEqual([{ line: 10, messages: [expect.stringMatching(/cost 0.*Revalue/)] }]);
      expect(await level(ISBN_A, front)).toBeUndefined();
    });

    it('a staff member with assigned locations imports only into them', async () => {
      const res = await post('opening-stock/check', `${STOCK}\r\n${ISBN_A},,Back Store,1,5,\r\n${ISBN_A},,Front,1,5,`, limitedClerk);
      expect(errorsByLine(res.body)[2]).toMatch(/not one of your locations/);
      expect(ImportReportSchema.parse(res.body).valid).toBe(1);
    });

    it('records opening stock at its cost, with the reorder point, and audits it', async () => {
      const csv = [STOCK, `${ISBN_A},${NAME} Book A,Front,10,45.50,3`, `SKU-${NAME}-SKU-1,,Back Store,6,0,`, `${ISBN_B},,Back Store,0,,2`].join('\r\n');
      const res = await post('opening-stock', csv, clerk);
      expect(res.body).toMatchObject({ kind: 'opening-stock' });
      expect(res.status).toBe(200);
      expect(ImportResultSchema.parse(res.body)).toMatchObject({ created: 2, updated: 1, skipped: 0 });
      expect(await level(ISBN_A, front)).toEqual({ quantity: 10, cost: '45.5000', reorder_point: 3 });
      expect(await level(`SKU-${NAME}-SKU-1`, back)).toMatchObject({ quantity: 6, cost: '0.0000' });
      expect(await level(ISBN_B, back)).toMatchObject({ quantity: 0, reorder_point: 2 });
      const history = (await db.query(
        `SELECT h.reason_code, h.qty_after, h.unit_cost::text AS unit_cost, h.reference_type FROM inventory_history h JOIN books b ON b.id = h.book_id WHERE b.isbn = $1`, [ISBN_A],
      )).rows;
      expect(history).toEqual([{ reason_code: 'initial', qty_after: 10, unit_cost: '45.50', reference_type: 'initial_stock' }]);
      const audit = (await db.query(`SELECT meta FROM audit_logs WHERE entity_type = 'data_import' AND meta->>'fileName' = 'opening-stock.csv'`)).rows;
      expect(audit).toEqual([{ meta: expect.objectContaining({ kind: 'opening-stock', created: 2, updated: 1 }) }]);
    });

    it('adds nothing when the file comes again; a different quantity is a stock count, not a second opening stock', async () => {
      const same = [STOCK, `${ISBN_A},${NAME} Book A,Front,10,45.50,3`, `SKU-${NAME}-SKU-1,,Back Store,6,0,`].join('\r\n');
      expect(ImportReportSchema.parse((await post('opening-stock/check', same)).body)).toMatchObject({ valid: 2, toCreate: 0, toUpdate: 0, unchanged: 2 });
      expect(ImportResultSchema.parse((await post('opening-stock', same)).body)).toMatchObject({ created: 0, updated: 0 });
      expect((await level(ISBN_A, front)).quantity).toBe(10);

      const more = [STOCK, `${ISBN_A},,Front,12,45.50,5`].join('\r\n');
      expect(errorsByLine((await post('opening-stock/check', more)).body)[2]).toMatch(/already has stock here \(10\).*stock count/);
      // The reorder point alone may change.
      const reorder = [STOCK, `${ISBN_A},,Front,10,,5`].join('\r\n');
      expect(ImportResultSchema.parse((await post('opening-stock', reorder)).body)).toMatchObject({ created: 0, updated: 1 });
      expect((await level(ISBN_A, front)).reorder_point).toBe(5);
    });

    it('exports the branch stock, with the cost only for those who see costs, and the export imports back unchanged', async () => {
      const res = await as(api().get('/api/v1/exports/opening-stock'), manager);
      expect(res.status).toBe(200);
      const lines = res.text.replace(/^\uFEFF/, '').split('\r\n');
      expect(lines[0]).toBe(STOCK);
      expect(lines).toContain(`${ISBN_A},${NAME} Book A,Front,10,45.50,5`);
      const ours = [lines[0], ...lines.filter((l) => l.includes(NAME))].join('\r\n');
      expect(ImportReportSchema.parse((await post('opening-stock/check', ours)).body)).toMatchObject({ rows: 3, valid: 3, toCreate: 0, toUpdate: 0, unchanged: 3 });

      const clerkLines = (await as(api().get('/api/v1/exports/opening-stock'), clerk)).text.replace(/^\uFEFF/, '').split('\r\n');
      expect(clerkLines).toContain(`${ISBN_A},${NAME} Book A,Front,10,,5`);
    });
  });

  describe('customers', () => {
    it('gives its template, and only Admin and Manager import or export customers', async () => {
      const res = await as(api().get('/api/v1/imports/customers/template'), manager);
      expect(res.text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(CUSTOMER_IMPORT_COLUMNS.join(','));
      expect(CUSTOMER_IMPORT_COLUMNS.join(',')).toBe(CUSTOMERS);
      expect((await post('customers/check', `${CUSTOMERS}\r\n,${NAME} X,0911,,,`, clerk)).status).toBe(403);
      expect((await as(api().get('/api/v1/exports/customers'), sales)).status).toBe(403);
    });

    it('checks every row: a name, a way to find the customer again, a known code, contacts used once', async () => {
      await post('customers', `${CUSTOMERS}\r\n,${NAME} Existing,+251911000999,existing@example.et,,`);
      const csv = [
        CUSTOMERS,
        `,${NAME} Almaz,+251911000111,almaz@example.et,Bole,Addis Ababa`,
        `,,+251911000222,,,`,
        `,${NAME} No Contact,,,,`,
        `CUS-99999,${NAME} Unknown Code,,,,`,
        `,${NAME} Same Phone,+251911000111,,,`,
        `,${NAME} Taken,+251911000333,existing@example.et,,`,
      ].join('\r\n');
      const res = await post('customers/check', csv, manager);
      expect(ImportReportSchema.parse(res.body)).toMatchObject({ kind: 'customers', rows: 6, valid: 2, toCreate: 1, toUpdate: 1 });
      const byLine = errorsByLine(res.body);
      expect(byLine[3]).toMatch(/Name/);
      expect(byLine[4]).toMatch(/a Code, a Phone or an Email/);
      expect(byLine[5]).toMatch(/No customer with code CUS-99999/);
      expect(byLine[6]).toMatch(/line 2/);
      expect(byLine[7]).toBeUndefined();
    });

    it('creates customers with codes and encrypted contacts, matches them again by code, phone or email, and updates what changed', async () => {
      const csv = [CUSTOMERS, `,${NAME} Almaz,+251911000111,almaz@example.et,Bole,Addis Ababa`, `,${NAME} Dawit,+251922000222,,,`].join('\r\n');
      expect(ImportResultSchema.parse((await post('customers', csv)).body)).toMatchObject({ created: 2, updated: 0 });
      const almaz = (await db.query(`SELECT customer_code, phone_encrypted, phone_lookup, city FROM customers WHERE full_name = $1`, [`${NAME} Almaz`])).rows[0];
      expect(almaz.customer_code).toMatch(/^CUS-/);
      expect(almaz.phone_encrypted).not.toContain('251911000111');
      expect(almaz.city).toBe('Addis Ababa');

      expect(ImportReportSchema.parse((await post('customers/check', csv)).body)).toMatchObject({ toCreate: 0, toUpdate: 0, unchanged: 2 });
      const changed = [CUSTOMERS, `${almaz.customer_code},,,,,Adama`, `,,+251922000222,dawit@example.et,,`].join('\r\n');
      expect(ImportResultSchema.parse((await post('customers', changed, manager)).body)).toMatchObject({ created: 0, updated: 2 });
      expect((await db.query(`SELECT city FROM customers WHERE full_name = $1`, [`${NAME} Almaz`])).rows[0].city).toBe('Adama');
    });

    it('exports the customers with their contacts, audited, and the export imports back unchanged', async () => {
      const res = await as(api().get('/api/v1/exports/customers'), manager);
      expect(res.status).toBe(200);
      const lines = res.text.replace(/^\uFEFF/, '').split('\r\n');
      expect(lines[0]).toBe(CUSTOMERS);
      // A cell starting with + would be a formula to a spreadsheet: it goes out as text.
      expect(lines.find((l) => l.includes(`${NAME} Dawit`))).toMatch(/,'\+251922000222,dawit@example\.et,,$/);
      const audit = (await db.query(
        `SELECT action, meta FROM audit_logs WHERE entity_type = 'data_import' AND action = 'EXPORT' AND meta->>'kind' = 'customers' ORDER BY id DESC LIMIT 1`,
      )).rows[0];
      expect(audit.meta.rows).toBeGreaterThanOrEqual(3);
      const ours = [lines[0], ...lines.filter((l) => l.includes(NAME))].join('\r\n');
      expect(ImportReportSchema.parse((await post('customers/check', ours)).body)).toMatchObject({ rows: 3, valid: 3, toCreate: 0, toUpdate: 0, unchanged: 3 });
    });
  });
});
