import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Books after the move to the layered structure (#21, catalog part 2 of 2).
// Each test names what the endpoint did before.

const STAFF_PREFIX = 'bookrule_test_';
const BRANCH_PREFIX = 'Book Rule ';
const NAME = 'Bookrule';
const ISBN10 = '9992158107';
const ISBN10_AS_13 = '9789992158104';
const ISBN10_WITH_X = '185326041X';
const ISBN10_WITH_X_AS_13 = '9781853260414';

describe('Books', () => {
  let branchA: number;
  let branchB: number;
  let admin: string;
  let managerA: string;
  let globalAdmin: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = admin) => r.set('Authorization', `Bearer ${token}`);

  async function createBook(body: Record<string, unknown>): Promise<{ id: number; isbn: string; authorIds: number[]; authors: string[] }> {
    const res = await as(api().post('/api/v1/books')).send(body);
    expect(res.status).toBe(201);
    return res.body;
  }

  async function cleanUp() {
    const books = (await db.query(`SELECT id FROM books WHERE title LIKE $1`, [`${NAME}%`])).rows.map((r) => r.id);
    if (books.length) {
      for (const table of ['book_authors', 'book_categories', 'book_tags', 'book_branch_prices', 'book_edit_history']) {
        await db.query(`DELETE FROM ${table} WHERE book_id = ANY($1)`, [books]);
      }
      await db.query(`DELETE FROM books WHERE id = ANY($1)`, [books]);
    }
    await db.query(`DELETE FROM authors WHERE normalized_name LIKE $1`, [`${NAME.toLowerCase()}%`]);
    await db.query(`DELETE FROM categories WHERE normalized_name LIKE $1`, [`${NAME.toLowerCase()}%`]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    admin = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId: branchA })).token;
    managerA = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId: branchA })).token;
    const g = await createTestStaff({ username: `${STAFF_PREFIX}global`, role: 'Admin', branchId: branchA });
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [g.staffId]);
    globalAdmin = g.token;
  });

  afterAll(cleanUp);

  describe('branch prices', () => {
    it('refuses another branch\'s price to a Manager of one branch (was: 200)', async () => {
      const book = await createBook({ title: `${NAME} Priced`, sku: 'BOOKRULE-PRICE' });
      const res = await as(api().put(`/api/v1/books/${book.id}/prices/${branchB}`), managerA).send({ price: 12.5 });
      expect(res.status).toBe(403);
      expect((await as(api().get(`/api/v1/books/${book.id}/prices`))).body.items).toHaveLength(0);
    });

    it('lets them set their own branch\'s price, and staff with access to all branches any branch\'s', async () => {
      const book = await createBook({ title: `${NAME} Priced Twice`, sku: 'BOOKRULE-PRICE2' });
      expect((await as(api().put(`/api/v1/books/${book.id}/prices/${branchA}`), managerA).send({ price: 12.5 })).status).toBe(200);
      expect((await as(api().put(`/api/v1/books/${book.id}/prices/${branchB}`), globalAdmin).send({ price: 13 })).status).toBe(200);
      const prices = (await as(api().get(`/api/v1/books/${book.id}/prices`))).body.items;
      expect(prices.map((p: { branchId: number; price: number }) => [p.branchId, p.price]).sort()).toEqual(
        [[branchA, 12.5], [branchB, 13]].sort(),
      );
    });
  });

  describe('authors and categories by name', () => {
    it('match an existing author ignoring letter case without renaming it (was: renamed)', async () => {
      await as(api().post('/api/v1/authors')).send({ name: `${NAME} Author Kept` });
      const book = await createBook({ title: `${NAME} Same Author`, sku: 'BOOKRULE-AUTH', authors: [`${NAME.toUpperCase()} AUTHOR KEPT`] });
      expect(book.authors).toEqual([`${NAME} Author Kept`]);
    });

    it('refuse an archived author named on a book (was: linked)', async () => {
      const id = (await as(api().post('/api/v1/authors')).send({ name: `${NAME} Author Archived` })).body.id;
      await as(api().post(`/api/v1/authors/${id}/archive`));
      const res = await as(api().post('/api/v1/books')).send({ title: `${NAME} Archived Author`, sku: 'BOOKRULE-ARCH', authors: [`${NAME} Author Archived`] });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('AUTHOR_NOT_SELECTABLE');
    });

    it('refuse an inactive category named on a book (was: linked)', async () => {
      const id = (await as(api().post('/api/v1/categories')).send({ name: `${NAME} Category Inactive` })).body.id;
      await as(api().post(`/api/v1/categories/${id}/deactivate`));
      const res = await as(api().post('/api/v1/books')).send({ title: `${NAME} Inactive Category`, sku: 'BOOKRULE-CAT', categories: [`${NAME} Category Inactive`] });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('CATEGORY_NOT_SELECTABLE');
    });

    it('list each author id once, in the order of the names (was: repeated once per category)', async () => {
      const book = await createBook({
        title: `${NAME} Two By Two`,
        sku: 'BOOKRULE-TWO',
        authors: [`${NAME} Author A`, `${NAME} Author B`],
        categories: [`${NAME} Category A`, `${NAME} Category B`],
      });
      expect(book.authorIds).toHaveLength(2);
      expect(book.authors).toEqual([`${NAME} Author A`, `${NAME} Author B`]);
    });
  });

  it('suggests only active authors (was: archived ones too)', async () => {
    const id = (await as(api().post('/api/v1/authors')).send({ name: `${NAME} Suggest Archived` })).body.id;
    await as(api().post(`/api/v1/authors/${id}/archive`));
    await as(api().post('/api/v1/authors')).send({ name: `${NAME} Suggest Active` });
    const res = await as(api().get(`/api/v1/catalog/authors/suggest?q=${NAME}%20suggest`));
    expect(res.body.items).toEqual([`${NAME} Suggest Active`]);
  });

  it('pages through a search (was: every page the first one)', async () => {
    for (const n of [1, 2, 3]) await createBook({ title: `${NAME} Paged ${n}`, sku: `BOOKRULE-PAGE${n}` });
    const page = async (p: number) =>
      (await as(api().get(`/api/v1/books?q=${NAME}%20Paged&page=${p}&pageSize=2&sortBy=title`))).body;
    const first = await page(1);
    const second = await page(2);
    expect(first.total).toBe(3);
    expect(first.items.map((b: { title: string }) => b.title)).toEqual([`${NAME} Paged 1`, `${NAME} Paged 2`]);
    expect(second.items.map((b: { title: string }) => b.title)).toEqual([`${NAME} Paged 3`]);
  });

  describe('ISBN-10', () => {
    it('is accepted and stored as its ISBN-13 (was: 400)', async () => {
      const book = await createBook({ title: `${NAME} Old Print`, isbn: ISBN10 });
      expect(book.isbn).toBe(ISBN10_AS_13);
      const withX = await createBook({ title: `${NAME} Old Print X`, isbn: ISBN10_WITH_X });
      expect(withX.isbn).toBe(ISBN10_WITH_X_AS_13);
    });

    it('is the same book as its ISBN-13', async () => {
      const res = await as(api().post('/api/v1/books')).send({ title: `${NAME} Old Print Again`, isbn: ISBN10_AS_13 });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('DUPLICATE_ISBN');
    });

    it('finds the book by either number', async () => {
      for (const path of [`books?isbn=${ISBN10}`, `books?q=${ISBN10}`, `catalog/search?q=${ISBN10}`]) {
        const body = (await as(api().get(`/api/v1/${path}`))).body;
        expect((body.items ?? body.results).map((b: { isbn: string }) => b.isbn)).toContain(ISBN10_AS_13);
      }
    });

    it('still refuses a wrong check digit', async () => {
      const res = await as(api().post('/api/v1/books')).send({ title: `${NAME} Bad Isbn`, isbn: '9992158108' });
      expect(res.status).toBe(400);
    });
  });

  describe('lifecycle', () => {
    it('refuses to reactivate an archived book; it must be restored (was: 200)', async () => {
      const book = await createBook({ title: `${NAME} Archived Book`, sku: 'BOOKRULE-LIFE' });
      expect((await as(api().post(`/api/v1/books/${book.id}/archive`))).status).toBe(200);
      const res = await as(api().post(`/api/v1/books/${book.id}/reactivate`));
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INVALID_LIFECYCLE_TRANSITION');
      expect((await as(api().post(`/api/v1/books/${book.id}/restore`))).status).toBe(200);
      const after = (await as(api().get(`/api/v1/books/${book.id}`))).body;
      expect([after.status, after.isActive]).toEqual(['ACTIVE', true]);
    });

    it('writes one audit entry when a book is deactivated twice (was: two)', async () => {
      const book = await createBook({ title: `${NAME} Deactivated Twice`, sku: 'BOOKRULE-TWICE' });
      await as(api().post(`/api/v1/books/${book.id}/deactivate`));
      await as(api().post(`/api/v1/books/${book.id}/deactivate`));
      const count = Number((await db.query(
        `SELECT COUNT(*) FROM audit_logs WHERE entity_type = 'book' AND entity_id = $1 AND action = 'INACTIVATE'`,
        [String(book.id)],
      )).rows[0].count);
      expect(count).toBe(1);
    });
  });
});
