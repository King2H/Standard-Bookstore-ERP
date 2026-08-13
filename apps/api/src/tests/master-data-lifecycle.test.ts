/**
 * Master Data Lifecycle (Prompt 3) — the 10 required test scenarios from
 * the spec: unified ACTIVE/INACTIVE/ARCHIVED status model, dependency-
 * guarded deletion, archive/restore, consumer-module cascade (search
 * visibility), historical-display integrity, status filters, and audit
 * logging.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'mdl_test_';
const BRANCH_PREFIX = 'MDL Test ';
const NAME_PREFIX = 'MDLTest';

async function getTestBook(): Promise<number> {
  const result = await db.query(`SELECT id FROM books WHERE is_active = true LIMIT 1`);
  if (!result.rows.length) throw new Error('No active books found');
  return result.rows[0].id as number;
}

describe('Master Data Lifecycle (Prompt 3)', () => {
  let adminToken: string;
  let branchId: number;
  let locationId: number;
  let customerId: number;
  // Set by test 5-8; cleaned up explicitly in afterAll (order_line_items →
  // orders → inventory before the book, matching the FK teardown order
  // other order-creating tests in this suite already use).
  let lifecycleOrderId: string | undefined;
  let lifecycleBookId: number | undefined;

  beforeAll(async () => {
    // Guard against a prior failed run leaving books.updated_by/archived_by
    // pointing at a stale staff row under this prefix (see afterAll).
    await db.query(
      `UPDATE books SET updated_by = NULL WHERE updated_by IN (SELECT id FROM staff WHERE username LIKE $1)`,
      [`${STAFF_PREFIX}%`],
    ).catch(() => {});
    await db.query(
      `UPDATE books SET archived_by = NULL WHERE archived_by IN (SELECT id FROM staff WHERE username LIKE $1)`,
      [`${STAFF_PREFIX}%`],
    ).catch(() => {});
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    await db.query(`DELETE FROM authors WHERE name LIKE $1`, [`${NAME_PREFIX}%`]);
    await db.query(`DELETE FROM publishers WHERE name LIKE $1`, [`${NAME_PREFIX}%`]);

    const branch = await createTestBranch({ name: `${BRANCH_PREFIX}Branch` });
    branchId = branch.branchId;
    const admin = await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId });
    adminToken = admin.token;

    const locRes = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'MDL Test Location', true) RETURNING id`,
      [branchId],
    );
    locationId = locRes.rows[0].id as number;

    const custRes = await db.query(
      `INSERT INTO customers (branch_id, customer_code, full_name, phone, is_active, created_at)
       VALUES ($1, 'MDLCUS-001', 'MDL Test Customer', '555-9999', true, now())
       RETURNING id`,
      [branchId],
    );
    customerId = custRes.rows[0].id as number;
  });

  afterAll(async () => {
    // Test 5-8's order + book: assertions are done by the time afterAll
    // runs, so tear the historical-invoice fixture all the way down —
    // order_line_items/inventory_reservations → orders → inventory →
    // book_authors → the book itself — same FK order other order-creating
    // tests in this suite use, so the delete-guard never has to be worked
    // around (it's exercised, not defeated).
    if (lifecycleOrderId) {
      await db.query(`DELETE FROM order_payments WHERE order_id = $1`, [lifecycleOrderId]).catch(() => {});
      await db.query(`DELETE FROM inventory_reservations WHERE order_id = $1`, [lifecycleOrderId]).catch(() => {});
      await db.query(`DELETE FROM order_line_items WHERE order_id = $1`, [lifecycleOrderId]).catch(() => {});
      await db.query(`DELETE FROM receivables WHERE source_entity_id = $1`, [lifecycleOrderId]).catch(() => {});
      await db.query(`DELETE FROM orders WHERE id = $1`, [lifecycleOrderId]).catch(() => {});
    }
    if (lifecycleBookId) {
      await db.query(`DELETE FROM inventory_history WHERE book_id = $1`, [lifecycleBookId]).catch(() => {});
      await db.query(`DELETE FROM inventory WHERE book_id = $1`, [lifecycleBookId]).catch(() => {});
      await db.query(`DELETE FROM book_authors WHERE book_id = $1`, [lifecycleBookId]).catch(() => {});
      await db.query(`DELETE FROM books WHERE id = $1`, [lifecycleBookId]).catch(() => {});
    }
    await db.query(`DELETE FROM customers WHERE customer_code = 'MDLCUS-001'`).catch(() => {});
    await db.query(`DELETE FROM authors WHERE name LIKE $1`, [`${NAME_PREFIX}%`]).catch(() => {});
    await db.query(`DELETE FROM publishers WHERE name LIKE $1`, [`${NAME_PREFIX}%`]).catch(() => {});
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  async function createAuthor(name: string) {
    const res = await request(getTestApp())
      .post('/api/authors')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ name });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  // ── 1. Delete unused author succeeds ────────────────────────────────────

  it('1. Delete unused author succeeds', async () => {
    const id = await createAuthor(`${NAME_PREFIX} Unused Author`);
    const res = await request(getTestApp())
      .delete(`/api/authors/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(res.status).toBe(200);
  });

  // ── 2. Delete referenced author fails with dependency summary ──────────

  it('2. Delete referenced author fails with dependency summary', async () => {
    const authorId = await createAuthor(`${NAME_PREFIX} Referenced Author`);
    const bookId = await getTestBook();
    await db.query(
      `INSERT INTO book_authors (book_id, author_id, sort_order) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`,
      [bookId, authorId],
    );

    const res = await request(getTestApp())
      .delete(`/api/authors/${authorId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AUTHOR_IN_USE');
    expect(res.body.details.books).toBeGreaterThan(0);

    await db.query(`DELETE FROM book_authors WHERE book_id = $1 AND author_id = $2`, [bookId, authorId]);
  });

  // ── 3. Archive author hides it from catalog dropdowns ───────────────────

  it('3. Archive author hides it from catalog dropdowns (default status=active)', async () => {
    const id = await createAuthor(`${NAME_PREFIX} To Archive`);

    const archiveRes = await request(getTestApp())
      .post(`/api/authors/${id}/archive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(archiveRes.status).toBe(200);

    // Default dropdown fetch (no ?status=) — active-only, must not include it.
    const dropdownRes = await request(getTestApp())
      .get(`/api/authors?pageSize=200`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(dropdownRes.status).toBe(200);
    expect(dropdownRes.body.items.some((a: { id: number }) => a.id === id)).toBe(false);

    // Explicit ?status=archived — must include it.
    const archivedRes = await request(getTestApp())
      .get(`/api/authors?status=archived&pageSize=200`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(archivedRes.body.items.some((a: { id: number }) => a.id === id)).toBe(true);
  });

  // ── 4. Inactive publisher cannot be selected for new book ───────────────

  it('4. Inactive publisher cannot be selected for new book', async () => {
    const pubRes = await request(getTestApp())
      .post('/api/publishers')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ name: `${NAME_PREFIX} Inactive Publisher` });
    expect(pubRes.status).toBe(201);
    const publisherId = pubRes.body.id as number;

    const deactivateRes = await request(getTestApp())
      .post(`/api/publishers/${publisherId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(deactivateRes.status).toBe(200);

    const bookRes = await request(getTestApp())
      .post('/api/books')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        title: `${NAME_PREFIX} Book With Inactive Publisher`,
        authors: [`${NAME_PREFIX} Filler Author`],
        publisherId,
      });
    expect(bookRes.status).toBe(422);
    expect(bookRes.body.error).toBe('PUBLISHER_NOT_SELECTABLE');

    await db.query(`DELETE FROM publishers WHERE id = $1`, [publisherId]);
  });

  // ── 5 & 6 & 7 & 8. Book archive/search-cascade/historical-display/restore ─

  it('5-8. Archived book disappears from POS/procurement search, historical order still shows it, restore makes it searchable again', async () => {
    const bookRes = await request(getTestApp())
      .post('/api/books')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        title: `${NAME_PREFIX} Lifecycle Book`,
        authors: [`${NAME_PREFIX} Filler Author 2`],
        defaultPrice: 15,
      });
    expect(bookRes.status).toBe(201);
    const bookId = bookRes.body.id as number;
    const bookTitle = bookRes.body.title as string;
    lifecycleBookId = bookId;

    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
       VALUES ($1, $2, 10, 2, 0)
       ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = 10, version = 0`,
      [bookId, locationId],
    );

    // Create a credit-sale order referencing the book BEFORE archiving —
    // this is the "historical invoice" for test 7.
    const orderRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, saleType: 'credit_sale', customerId, items: [{ bookId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.id;
    lifecycleOrderId = orderId;

    // Sanity: while ACTIVE, both search surfaces find it.
    const posSearchBefore = await request(getTestApp())
      .get(`/api/books/with-availability?q=${encodeURIComponent(bookTitle)}&locationId=${locationId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(posSearchBefore.body.items.some((b: { id: number }) => b.id === bookId)).toBe(true);

    // ── Archive ──
    const archiveRes = await request(getTestApp())
      .post(`/api/books/${bookId}/archive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(archiveRes.status).toBe(200);

    // 5. Disappears from POS search (/books/with-availability, active-only default).
    const posSearchAfter = await request(getTestApp())
      .get(`/api/books/with-availability?q=${encodeURIComponent(bookTitle)}&locationId=${locationId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(posSearchAfter.body.items.some((b: { id: number }) => b.id === bookId)).toBe(false);

    // 6. Disappears from procurement search (/catalog/search, no branch/location context).
    const procSearchAfter = await request(getTestApp())
      .get(`/api/catalog/search?q=${encodeURIComponent(bookTitle)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(procSearchAfter.status).toBe(200);
    expect(procSearchAfter.body.results.some((b: { id: number }) => b.id === bookId)).toBe(false);

    // 7. Historical invoice (the order created before archiving) still shows the book.
    const orderDetailRes = await request(getTestApp())
      .get(`/api/orders/${orderId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(orderDetailRes.status).toBe(200);
    const lineItem = orderDetailRes.body.lineItems.find((li: { bookId: number }) => li.bookId === bookId);
    expect(lineItem).toBeDefined();
    expect(lineItem.bookTitle).toBe(bookTitle);

    // 8. Restore makes it searchable again.
    const restoreRes = await request(getTestApp())
      .post(`/api/books/${bookId}/restore`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(restoreRes.status).toBe(200);

    const posSearchRestored = await request(getTestApp())
      .get(`/api/books/with-availability?q=${encodeURIComponent(bookTitle)}&locationId=${locationId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(posSearchRestored.body.items.some((b: { id: number }) => b.id === bookId)).toBe(true);
  });

  // ── 9. Status filters return correct datasets ───────────────────────────

  it('9. Status filters (active/inactive/archived/all) return correct datasets', async () => {
    const activeId = await createAuthor(`${NAME_PREFIX} StatusActive`);
    const inactiveId = await createAuthor(`${NAME_PREFIX} StatusInactive`);
    const archivedId = await createAuthor(`${NAME_PREFIX} StatusArchived`);

    await request(getTestApp()).post(`/api/authors/${inactiveId}/deactivate`).set('Authorization', `Bearer ${adminToken}`).set('X-Branch-Id', String(branchId));
    await request(getTestApp()).post(`/api/authors/${archivedId}/archive`).set('Authorization', `Bearer ${adminToken}`).set('X-Branch-Id', String(branchId));

    async function fetchStatus(status: string): Promise<number[]> {
      const res = await request(getTestApp())
        .get(`/api/authors?status=${status}&q=${encodeURIComponent(NAME_PREFIX + ' Status')}&pageSize=200`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));
      return res.body.items.map((a: { id: number }) => a.id);
    }

    expect(await fetchStatus('active')).toEqual([activeId]);
    expect(await fetchStatus('inactive')).toEqual([inactiveId]);
    expect(await fetchStatus('archived')).toEqual([archivedId]);
    const all = await fetchStatus('all');
    expect(all).toEqual(expect.arrayContaining([activeId, inactiveId, archivedId]));
    expect(all.length).toBe(3);
  });

  // ── 10. Audit log records archive and restore actions ──────────────────

  it('10. Audit log records ARCHIVE and RESTORE actions with the correct entity/user/timestamp', async () => {
    const id = await createAuthor(`${NAME_PREFIX} Audit Author`);

    await request(getTestApp()).post(`/api/authors/${id}/archive`).set('Authorization', `Bearer ${adminToken}`).set('X-Branch-Id', String(branchId));
    await request(getTestApp()).post(`/api/authors/${id}/restore`).set('Authorization', `Bearer ${adminToken}`).set('X-Branch-Id', String(branchId));

    const res = await request(getTestApp())
      .get(`/api/audit-logs?entityType=author&pageSize=100`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(res.status).toBe(200);

    const entries = res.body.items.filter((e: { entityId: string }) => e.entityId === String(id));
    const archiveEntry = entries.find((e: { action: string }) => e.action === 'ARCHIVE');
    const restoreEntry = entries.find((e: { action: string }) => e.action === 'RESTORE');
    expect(archiveEntry).toBeDefined();
    expect(restoreEntry).toBeDefined();
    expect(archiveEntry.entityType).toBe('author');
    expect(archiveEntry.staffUsername).toBe(`${STAFF_PREFIX}admin`);
    expect(archiveEntry.createdAt).toBeTruthy();
    expect(archiveEntry.meta.newStatus).toBe('ARCHIVED');
    expect(restoreEntry.meta.newStatus).toBe('ACTIVE');
  });
});
