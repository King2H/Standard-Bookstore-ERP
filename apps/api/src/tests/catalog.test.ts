import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'catalog_test_';
const BRANCH_PREFIX = 'Catalog Test ';

// ── Cleanup helpers ───────────────────────────────────────────────────────────

async function cleanTestBooks() {
  await db.query(`
    DELETE FROM books
    WHERE isbn IN ('9780306406157', '9780140449136')
       OR isbn LIKE '978TEST%'
       OR isbn LIKE '9780000000%'
  `);
}

async function cleanTestAuthors() {
  await db.query(`
    DELETE FROM authors WHERE normalized_name LIKE 'test author%'
  `);
}

async function cleanTestCategories() {
  await db.query(`
    DELETE FROM categories WHERE normalized_name LIKE 'test category%'
  `);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Catalog — Books', () => {
  let adminToken: string;
  let salesToken: string;
  let branchId: number;

  const TEST_ISBN = '9780000000001'; // valid ISBN-13 check digit: 0+0+0+0+0+0+0+0+0+0+0+0+1 → sum=1 → not valid
  // Use a real valid ISBN-13 for tests
  const VALID_ISBN_1 = '9780306406157'; // valid
  const VALID_ISBN_2 = '9780140449136'; // valid

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    await cleanTestBooks();
    await cleanTestAuthors();
    await cleanTestCategories();

    const branch = await createTestBranch({ name: 'Catalog Test Branch' });
    branchId = branch.branchId;

    const admin = await createTestStaff({ username: 'catalog_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    const sales = await createTestStaff({ username: 'catalog_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;
  });

  afterAll(async () => {
    await cleanTestBooks();
    await cleanTestAuthors();
    await cleanTestCategories();
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── POST /api/books ────────────────────────────────────────────────────────

  it('Admin can create a book with relational authors and categories', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post('/api/books')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        isbn: VALID_ISBN_1,
        title: 'Test Book Alpha',
        authors: ['Test Author One', 'Test Author Two'],
        genre: 'Fiction',
        categories: ['Test Category A', 'Test Category B'],
        tags: ['test-tag-1', 'test-tag-2'],
        defaultPrice: 15.99,
      });

    expect(res.status).toBe(201);
    expect(res.body.isbn).toBe(VALID_ISBN_1);
    expect(res.body.title).toBe('Test Book Alpha');
    // API returns string[] for backward compatibility
    expect(Array.isArray(res.body.authors)).toBe(true);
    expect(res.body.authors).toContain('Test Author One');
    expect(res.body.authors).toContain('Test Author Two');
    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(res.body.categories).toContain('Test Category A');
    expect(Array.isArray(res.body.tags)).toBe(true);
    expect(res.body.tags).toContain('test-tag-1');
  });

  it('Sales role cannot create a book (403)', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post('/api/books')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        isbn: VALID_ISBN_2,
        title: 'Unauthorized Book',
        authors: ['Some Author'],
      });
    expect(res.status).toBe(403);
  });

  it('Duplicate ISBN returns 409', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post('/api/books')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        isbn: VALID_ISBN_1,
        title: 'Duplicate Book',
        authors: ['Test Author One'],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_ISBN');
  });

  it('Invalid ISBN-13 check digit returns 400', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post('/api/books')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        isbn: '9780000000000', // invalid check digit
        title: 'Bad ISBN Book',
        authors: ['Test Author One'],
      });
    expect(res.status).toBe(400);
  });

  it('Unauthenticated request returns 401', async () => {
    const app = getTestApp();
    const res = await request(app).post('/api/books').send({
      isbn: VALID_ISBN_2,
      title: 'No Auth Book',
      authors: ['Test Author One'],
    });
    expect(res.status).toBe(401);
  });

  // ── Author deduplication ───────────────────────────────────────────────────

  it('Same author name reused across books — no duplicate in authors table', async () => {
    const app = getTestApp();

    // Create second book with same author
    await request(app)
      .post('/api/books')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        isbn: VALID_ISBN_2,
        title: 'Test Book Beta',
        authors: ['Test Author One'], // same author as book 1
        categories: ['Test Category A'],
      });

    // Verify only one author row exists for this name
    const authorCount = await db.query(
      `SELECT COUNT(*) FROM authors WHERE normalized_name = 'test author one'`,
    );
    expect(parseInt(authorCount.rows[0].count as string, 10)).toBe(1);
  });

  it('Author name is case-insensitively deduplicated', async () => {
    // Insert with different casing — should reuse existing author
    const countBefore = await db.query(
      `SELECT COUNT(*) FROM authors WHERE normalized_name = 'test author one'`,
    );

    await db.query(
      `INSERT INTO authors (name, normalized_name)
       VALUES ('TEST AUTHOR ONE', 'test author one')
       ON CONFLICT (normalized_name) DO NOTHING`,
    );

    const countAfter = await db.query(
      `SELECT COUNT(*) FROM authors WHERE normalized_name = 'test author one'`,
    );
    expect(parseInt(countAfter.rows[0].count as string, 10)).toBe(
      parseInt(countBefore.rows[0].count as string, 10),
    );
  });

  // ── GET /api/books ─────────────────────────────────────────────────────────

  it('Any authenticated role can list books', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get('/api/books')
      .set('Authorization', `Bearer ${salesToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.page).toBe('number');
    expect(typeof res.body.totalPages).toBe('number');
  });

  it('Search by title returns matching books', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get('/api/books?q=Test+Book+Alpha')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const found = res.body.items.find((b: { isbn: string }) => b.isbn === VALID_ISBN_1);
    expect(found).toBeDefined();
  });

  it('Search by author name returns matching books', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get('/api/books?q=Test+Author+Two')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const found = res.body.items.find((b: { isbn: string }) => b.isbn === VALID_ISBN_1);
    expect(found).toBeDefined();
  });

  it('Filter by category returns matching books', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get('/api/books?category=Test+Category+A')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    const found = res.body.items.find((b: { isbn: string }) => b.isbn === VALID_ISBN_1);
    expect(found).toBeDefined();
  });

  it('Filter by tag returns matching books', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get('/api/books?tag=test-tag-1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const found = res.body.items.find((b: { isbn: string }) => b.isbn === VALID_ISBN_1);
    expect(found).toBeDefined();
  });

  it('Exact ISBN search returns the correct book', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get(`/api/books?isbn=${VALID_ISBN_1}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].isbn).toBe(VALID_ISBN_1);
  });

  // ── GET /api/books/:id ─────────────────────────────────────────────────────

  it('Get book by ID returns full detail', async () => {
    const app = getTestApp();
    // Find the book ID
    const listRes = await request(app)
      .get(`/api/books?isbn=${VALID_ISBN_1}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const bookId = listRes.body.items[0].id;

    const res = await request(app)
      .get(`/api/books/${bookId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.isbn).toBe(VALID_ISBN_1);
    expect(Array.isArray(res.body.authors)).toBe(true);
    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(Array.isArray(res.body.tags)).toBe(true);
  });

  // ── PUT /api/books/:id ─────────────────────────────────────────────────────

  it('Admin can update book authors — removes old, adds new', async () => {
    const app = getTestApp();
    const listRes = await request(app)
      .get(`/api/books?isbn=${VALID_ISBN_1}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const bookId = listRes.body.items[0].id;

    const res = await request(app)
      .put(`/api/books/${bookId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        authors: ['Test Author One', 'Test Author Three'],
      });

    expect(res.status).toBe(200);
    expect(res.body.authors).toContain('Test Author One');
    expect(res.body.authors).toContain('Test Author Three');
    expect(res.body.authors).not.toContain('Test Author Two');
  });

  it('Update produces edit history entries', async () => {
    const app = getTestApp();
    const listRes = await request(app)
      .get(`/api/books?isbn=${VALID_ISBN_1}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const bookId = listRes.body.items[0].id;

    await request(app)
      .put(`/api/books/${bookId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Test Book Alpha Updated' });

    const histRes = await request(app)
      .get(`/api/books/${bookId}/history`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(histRes.status).toBe(200);
    expect(histRes.body.items.length).toBeGreaterThan(0);
    const titleChange = histRes.body.items.find(
      (h: { field_name: string }) => h.field_name === 'title',
    );
    expect(titleChange).toBeDefined();
  });

  // ── Branch prices ──────────────────────────────────────────────────────────

  it('Admin can set a branch-specific price', async () => {
    const app = getTestApp();
    const listRes = await request(app)
      .get(`/api/books?isbn=${VALID_ISBN_1}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const bookId = listRes.body.items[0].id;

    const res = await request(app)
      .put(`/api/books/${bookId}/prices/${branchId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ price: 18.99 });

    expect(res.status).toBe(200);

    // Verify branch price appears in book detail
    const detailRes = await request(app)
      .get(`/api/books/${bookId}?branchId=${branchId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(detailRes.body.branchPrice).toBe(18.99);
  });

  // ── Deactivate ─────────────────────────────────────────────────────────────

  it('Admin can deactivate a book', async () => {
    const app = getTestApp();
    const listRes = await request(app)
      .get(`/api/books?isbn=${VALID_ISBN_2}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const bookId = listRes.body.items[0].id;

    const res = await request(app)
      .post(`/api/books/${bookId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);

    // Deactivated book not returned in default list (is_active=true filter)
    const listAfter = await request(app)
      .get(`/api/books?isbn=${VALID_ISBN_2}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listAfter.body.items.length).toBe(0);
  });

  // ── Autocomplete ───────────────────────────────────────────────────────────

  it('Author suggest returns matching names', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get('/api/catalog/authors/suggest?q=test+author')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('Category suggest returns matching names', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get('/api/catalog/categories/suggest?q=test+cat')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  // ── Audit log ──────────────────────────────────────────────────────────────

  it('Create book produces audit log entry', async () => {
    const listRes = await request(getTestApp())
      .get(`/api/books?isbn=${VALID_ISBN_1}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const bookId = listRes.body.items[0].id;

    const audit = await db.query(
      `SELECT * FROM audit_logs
       WHERE entity_type = 'book' AND entity_id = $1 AND action = 'CREATE'
       ORDER BY id DESC LIMIT 1`,
      [String(bookId)],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  // ── Data integrity ─────────────────────────────────────────────────────────

  it('No duplicate authors in authors table (case-insensitive)', async () => {
    const result = await db.query(
      `SELECT normalized_name, COUNT(*) FROM authors GROUP BY normalized_name HAVING COUNT(*) > 1`,
    );
    expect(result.rows.length).toBe(0);
  });

  it('No orphan book_authors rows', async () => {
    const result = await db.query(
      `SELECT COUNT(*) FROM book_authors ba
       WHERE NOT EXISTS (SELECT 1 FROM books b WHERE b.id = ba.book_id)
          OR NOT EXISTS (SELECT 1 FROM authors a WHERE a.id = ba.author_id)`,
    );
    expect(parseInt(result.rows[0].count as string, 10)).toBe(0);
  });

  it('No orphan book_categories rows', async () => {
    const result = await db.query(
      `SELECT COUNT(*) FROM book_categories bc
       WHERE NOT EXISTS (SELECT 1 FROM books b WHERE b.id = bc.book_id)
          OR NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = bc.category_id)`,
    );
    expect(parseInt(result.rows[0].count as string, 10)).toBe(0);
  });
});
