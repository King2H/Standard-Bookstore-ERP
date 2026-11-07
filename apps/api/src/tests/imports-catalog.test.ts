// #246 (owner decisions 1a–4a, 2026-11-07): a shop starts with its catalog
// imported from a file (CSV, 3a), not entered one book at a time (a shop of
// 5,000 titles). The file is checked first: each row valid or the reason it
// is not, nothing saved until it is clean, or only the valid rows if the user
// chooses. Re-importing the same file creates nothing twice (matched by ISBN,
// or SKU for a book without one). The same list exports to CSV, and an export
// imports back unchanged. Admin and Manager import. Before, there was no
// import or export of the catalog.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { CATALOG_IMPORT_COLUMNS, ImportReportSchema, ImportResultSchema } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'catimport_test_';
const BRANCH_PREFIX = 'Cat Import ';
const NAME = 'Catimport';

const HEADER = 'ISBN,SKU,Title,Authors,Publisher,Categories,Format,Language,Price';
const ISBN_A = '9780306406157';
const ISBN10_B = '0-19-852663-6'; // stored as 9780198526636
const ISBN_B = '9780198526636';

describe('Catalog import and export (#246)', () => {
  let admin: string;
  let manager: string;
  let clerk: string;
  let sales: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = admin) => r.set('Authorization', `Bearer ${token}`);
  const check = (csv: string, token = admin) => as(api().post('/api/v1/imports/catalog/check'), token).send({ csv, fileName: 'books.csv' });
  const save = (csv: string, onlyValid = false, token = admin) =>
    as(api().post('/api/v1/imports/catalog'), token).send({ csv, fileName: 'books.csv', onlyValid });
  const bookCount = async () => Number((await db.query(`SELECT count(*) AS n FROM books WHERE title LIKE $1`, [`${NAME}%`])).rows[0].n);
  const book = async (isbn: string) => (await db.query(
    `SELECT b.id, b.title, b.sku, b.language, b.default_price::text AS price, p.name AS publisher, f.code AS format,
            (SELECT string_agg(a.name, '; ' ORDER BY a.name) FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id) AS authors,
            (SELECT string_agg(c.name, '; ' ORDER BY c.name) FROM book_categories bc JOIN categories c ON c.id = bc.category_id WHERE bc.book_id = b.id) AS categories
     FROM books b LEFT JOIN publishers p ON p.id = b.publisher_id LEFT JOIN book_formats f ON f.id = b.format_id WHERE b.isbn = $1`, [isbn],
  )).rows[0];

  async function cleanUp() {
    const books = (await db.query(`SELECT id FROM books WHERE title LIKE $1 OR title LIKE $2`, [`${NAME}%`, `%${NAME}%`])).rows.map((r) => r.id);
    if (books.length) {
      for (const table of ['book_authors', 'book_categories', 'book_tags', 'book_branch_prices', 'book_edit_history']) {
        await db.query(`DELETE FROM ${table} WHERE book_id = ANY($1)`, [books]);
      }
      await db.query(`DELETE FROM books WHERE id = ANY($1)`, [books]);
    }
    await db.query(`DELETE FROM authors WHERE normalized_name LIKE $1`, [`${NAME.toLowerCase()}%`]);
    await db.query(`DELETE FROM categories WHERE normalized_name LIKE $1`, [`${NAME.toLowerCase()}%`]);
    await db.query(`DELETE FROM publishers WHERE lower(name) LIKE $1`, [`${NAME.toLowerCase()}%`]);
    await db.query(`DELETE FROM audit_logs WHERE entity_type = 'data_import' AND meta->>'fileName' LIKE 'books%'`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    const branch = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    admin = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId: branch })).token;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId: branch })).token;
    clerk = (await createTestStaff({ username: `${STAFF_PREFIX}clerk`, role: 'Stock_Clerk', branchId: branch })).token;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId: branch })).token;
    // An archived author cannot be linked to a book: a row naming it is refused.
    await db.query(`INSERT INTO authors (name, normalized_name, status) VALUES ('${NAME} Archived Author', '${NAME.toLowerCase()} archived author', 'ARCHIVED')`);
  });

  afterAll(cleanUp);

  it('gives a template with the columns, and only Admin and Manager import', async () => {
    const res = await as(api().get('/api/v1/imports/catalog/template'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(CATALOG_IMPORT_COLUMNS.join(','));
    expect(CATALOG_IMPORT_COLUMNS.join(',')).toBe(HEADER);

    expect((await check(`${HEADER}\r\n${ISBN_A},,${NAME} Rights,,,,,,10`, manager)).status).toBe(200);
    expect((await check(`${HEADER}\r\n${ISBN_A},,${NAME} Rights,,,,,,10`, clerk)).status).toBe(403);
    expect((await check(`${HEADER}\r\n${ISBN_A},,${NAME} Rights,,,,,,10`, sales)).status).toBe(403);
    expect((await api().post('/api/v1/imports/catalog/check').send({ csv: HEADER })).status).toBe(401);
    expect((await as(api().get('/api/v1/exports/catalog'), sales)).status).toBe(403);
  });

  it('checks every row and says why each bad one is refused, saving nothing', async () => {
    const csv = [
      HEADER,
      `${ISBN_A},,${NAME} Good One,"${NAME} Author A; ${NAME} Author B",${NAME} Press,${NAME} Fiction,Hardcover,Amharic,250.50`,
      `9780306406158,,${NAME} Bad Isbn,,,,,,10`,
      `,,${NAME} No Key,,,,,,10`,
      `,${NAME}-SKU-1,,,,,,,10`,
      `,${NAME}-SKU-2,${NAME} Bad Price,,,,,,12.345`,
      `,${NAME}-SKU-3,${NAME} Bad Format,,,,Scroll,,`,
      `${ISBN_A},,${NAME} Same Isbn Again,,,,,,10`,
      `,${NAME}-SKU-4,${NAME} Archived Author,${NAME} Archived Author,,,,,`,
      '',
    ].join('\r\n');
    const res = await check(csv);
    expect(res.status).toBe(200);
    const report = ImportReportSchema.parse(res.body);
    expect(report).toMatchObject({ kind: 'catalog', rows: 8, valid: 1, toCreate: 1, toUpdate: 0, unchanged: 0 });
    const byLine = Object.fromEntries(report.errors.map((e) => [e.line, e.messages.join(' | ')]));
    expect(byLine[3]).toMatch(/ISBN/);
    expect(byLine[4]).toMatch(/an ISBN or a SKU/);
    expect(byLine[5]).toMatch(/Title/);
    expect(byLine[6]).toMatch(/Price/);
    expect(byLine[7]).toMatch(/Format.*Scroll.*Hardcover/);
    expect(byLine[8]).toMatch(/line 2/);
    expect(byLine[9]).toMatch(/Archived Author.*not active/);
    expect(report.newNames).toEqual({
      authors: [`${NAME} Author A`, `${NAME} Author B`], categories: [`${NAME} Fiction`], publishers: [`${NAME} Press`], suppliers: [],
    });
    expect(await bookCount()).toBe(0);

    // Saving all of it is refused while a row is wrong, and nothing is saved.
    const refused = await save(csv);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe('IMPORT_HAS_ERRORS');
    expect(ImportReportSchema.parse(refused.body.details.report).valid).toBe(1);
    expect(await bookCount()).toBe(0);
  });

  it('saves the valid rows when asked, creating authors, categories and the publisher, and audits it', async () => {
    const csv = [
      HEADER,
      `${ISBN_A},,${NAME} Good One,"${NAME} Author A; ${NAME} Author B",${NAME} Press,${NAME} Fiction,Hardcover,Amharic,250.50`,
      `${ISBN10_B},,${NAME} From Isbn Ten,${NAME} Author A,,,softcover,,99`,
      `,${NAME}-SKU-5,${NAME} No Isbn,,,,,,`,
      `9780306406158,,${NAME} Bad Isbn,,,,,,10`,
    ].join('\r\n');
    const res = await save(csv, true);
    expect(res.status).toBe(200);
    expect(ImportResultSchema.parse(res.body)).toMatchObject({ created: 3, updated: 0, skipped: 1 });

    expect(await book(ISBN_A)).toMatchObject({
      title: `${NAME} Good One`, authors: `${NAME} Author A; ${NAME} Author B`, publisher: `${NAME} Press`,
      categories: `${NAME} Fiction`, format: 'hardcover', language: 'Amharic', price: '250.50',
    });
    expect(await book(ISBN_B)).toMatchObject({ title: `${NAME} From Isbn Ten`, format: 'softcover', price: '99.00' });
    expect(await book(`SKU-${NAME}-SKU-5`)).toMatchObject({ sku: `${NAME}-SKU-5`, price: null });

    const audit = (await db.query(
      `SELECT action, meta FROM audit_logs WHERE entity_type = 'data_import' AND meta->>'fileName' = 'books.csv' ORDER BY id DESC LIMIT 1`,
    )).rows[0];
    expect(audit).toMatchObject({ action: 'IMPORT', meta: { kind: 'catalog', fileName: 'books.csv', created: 3, updated: 0, skipped: 1 } });
  });

  it('creates nothing twice when the same file comes again, and updates only what changed', async () => {
    const same = [
      HEADER,
      `${ISBN_A},,${NAME} Good One,"${NAME} Author A; ${NAME} Author B",${NAME} Press,${NAME} Fiction,Hardcover,Amharic,250.50`,
      `${ISBN10_B},,${NAME} From Isbn Ten,${NAME} Author A,,,softcover,,99`,
      `,${NAME}-SKU-5,${NAME} No Isbn,,,,,,`,
    ].join('\r\n');
    expect(ImportReportSchema.parse((await check(same)).body)).toMatchObject({ valid: 3, toCreate: 0, toUpdate: 0, unchanged: 3 });
    expect(ImportResultSchema.parse((await save(same)).body)).toMatchObject({ created: 0, updated: 0 });
    expect(await bookCount()).toBe(3);

    // A new price; an empty cell leaves the book's value as it is.
    const changed = [HEADER, `${ISBN_A},,${NAME} Good One,,,,,,275`].join('\r\n');
    expect(ImportReportSchema.parse((await check(changed)).body)).toMatchObject({ toUpdate: 1, unchanged: 0 });
    expect(ImportResultSchema.parse((await save(changed, false, manager)).body)).toMatchObject({ created: 0, updated: 1 });
    expect(await book(ISBN_A)).toMatchObject({ price: '275.00', authors: `${NAME} Author A; ${NAME} Author B`, publisher: `${NAME} Press` });
    const edits = (await db.query(
      `SELECT field_name AS field, old_value, new_value FROM book_edit_history WHERE book_id = (SELECT id FROM books WHERE isbn = $1)`, [ISBN_A],
    )).rows;
    expect(edits).toEqual([expect.objectContaining({ field: 'default_price', new_value: '275' })]);
  });

  it('exports the catalog to CSV, and an export imports back unchanged, formulas kept as text', async () => {
    await save([HEADER, `,${NAME}-SKU-6,"=1+1 ${NAME} Formula",,,,,,5`, `,${NAME}-SKU-7,"-${NAME} Dash",,,,,,`].join('\r\n'));
    const res = await as(api().get('/api/v1/exports/catalog'), manager);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="catalog-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = res.text.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe(HEADER);
    expect(lines).toContain(`${ISBN_A},,${NAME} Good One,${NAME} Author A; ${NAME} Author B,${NAME} Press,${NAME} Fiction,Hardcover,Amharic,275.00`);
    // A cell a spreadsheet would run as a formula goes out as text.
    expect(lines).toContain(`SKU-${NAME}-SKU-6,${NAME}-SKU-6,'=1+1 ${NAME} Formula,,,,,,5.00`);

    const ours = [lines[0], ...lines.filter((l) => l.includes(NAME))].join('\r\n');
    const back = ImportReportSchema.parse((await check(ours)).body);
    expect(back).toMatchObject({ rows: 5, valid: 5, toCreate: 0, toUpdate: 0, unchanged: 5 });
    expect((await book(`SKU-${NAME}-SKU-6`)).title).toBe(`=1+1 ${NAME} Formula`);
  });

  it('reads a file saved by Excel: semicolons, a byte-order mark, and quoted cells over lines', async () => {
    const csv = `\uFEFF${HEADER.replace(/,/g, ';')}\r\n;${NAME}-SKU-8;"${NAME} Two\nLines";"${NAME} Author A";;;;;"12,50"`;
    const report = ImportReportSchema.parse((await check(csv)).body);
    expect(report).toMatchObject({ rows: 1, valid: 1, toCreate: 1 });
  });

  it('takes a file of 5,000 books', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => `,${NAME}-BULK-${i},${NAME} Bulk ${i},${NAME} Bulk Author ${i % 50},,,,,${(i % 90) + 10}`);
    const csv = [HEADER, ...rows].join('\r\n');
    expect(csv.length).toBeGreaterThan(200_000);
    const report = ImportReportSchema.parse((await check(csv)).body);
    expect(report).toMatchObject({ rows: 5000, valid: 5000, toCreate: 5000 });
  }, 120_000);
});
