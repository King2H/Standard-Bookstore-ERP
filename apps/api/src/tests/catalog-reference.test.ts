import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Catalog reference data (authors, categories, publishers) after the move to
// the layered structure (#21, catalog part 1 of 2). Each test names what the
// endpoint did before.

const STAFF_PREFIX = 'refrule_test_';
const BRANCH_PREFIX = 'Ref Rule ';
const NAME = 'Refrule';

describe('Catalog reference data', () => {
  let admin: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test) => r.set('Authorization', `Bearer ${admin}`);

  async function create(path: string, body: Record<string, unknown>): Promise<number> {
    const res = await as(api().post(`/api/v1/${path}`)).send(body);
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function auditCount(entityType: string, id: number, action: string): Promise<number> {
    return Number((await db.query(
      `SELECT COUNT(*) FROM audit_logs WHERE entity_type = $1 AND entity_id = $2 AND action = $3`,
      [entityType, String(id), action],
    )).rows[0].count);
  }

  async function cleanUp() {
    const pattern = `${NAME.toLowerCase()}%`;
    await db.query(`UPDATE categories SET parent_id = NULL WHERE normalized_name LIKE $1`, [pattern]);
    await db.query(`DELETE FROM categories WHERE normalized_name LIKE $1`, [pattern]);
    await db.query(`DELETE FROM authors WHERE normalized_name LIKE $1`, [pattern]);
    await db.query(`DELETE FROM publishers WHERE lower(name) LIKE $1`, [pattern]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    const branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
    admin = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId })).token;
  });

  afterAll(cleanUp);

  describe('category tree', () => {
    it('refuses a category as its own parent (was: 200)', async () => {
      const id = await create('categories', { name: `${NAME} Self` });
      const res = await as(api().put(`/api/v1/categories/${id}`)).send({ parentId: id });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('refuses a category under one of its own subcategories (was: 200, a loop)', async () => {
      const top = await create('categories', { name: `${NAME} Top` });
      const child = await create('categories', { name: `${NAME} Child`, parentId: top });
      const grandchild = await create('categories', { name: `${NAME} Grandchild`, parentId: child });
      const res = await as(api().put(`/api/v1/categories/${top}`)).send({ parentId: grandchild });
      expect(res.status).toBe(400);
      const row = (await db.query(`SELECT parent_id FROM categories WHERE id = $1`, [top])).rows[0];
      expect(row.parent_id).toBeNull();
    });

    it('answers 404 for a parent that does not exist (was: 500)', async () => {
      const res = await as(api().post('/api/v1/categories')).send({ name: `${NAME} Orphan`, parentId: 2_000_000_000 });
      expect(res.status).toBe(404);
    });
  });

  it('refuses a name of only spaces on update (was: 200, an empty name)', async () => {
    const author = await create('authors', { name: `${NAME} Author Spaces` });
    const category = await create('categories', { name: `${NAME} Category Spaces` });
    const publisher = await create('publishers', { name: `${NAME} Publisher Spaces` });
    for (const path of [`authors/${author}`, `categories/${category}`, `publishers/${publisher}`]) {
      const res = await as(api().put(`/api/v1/${path}`)).send({ name: '   ' });
      expect(res.status).toBe(400);
    }
  });

  it('refuses a malformed id with 400 (was: 500)', async () => {
    expect((await as(api().put('/api/v1/authors/abc')).send({ name: `${NAME} X` })).status).toBe(400);
    expect((await as(api().post('/api/v1/publishers/abc/archive'))).status).toBe(400);
    expect((await as(api().delete('/api/v1/categories/abc'))).status).toBe(400);
  });

  it('audits a change to a category or a publisher (was: no entry)', async () => {
    const category = await create('categories', { name: `${NAME} Audited Category` });
    const publisher = await create('publishers', { name: `${NAME} Audited Publisher` });
    expect((await as(api().put(`/api/v1/categories/${category}`)).send({ name: `${NAME} Audited Category 2` })).status).toBe(200);
    expect((await as(api().put(`/api/v1/publishers/${publisher}`)).send({ name: `${NAME} Audited Publisher 2` })).status).toBe(200);
    expect(await auditCount('category', category, 'UPDATE')).toBe(1);
    expect(await auditCount('publisher', publisher, 'UPDATE')).toBe(1);
  });

  it('treats publisher names that differ only in letter case as the same (was: 201, a second publisher)', async () => {
    await create('publishers', { name: `${NAME} Press` });
    const res = await as(api().post('/api/v1/publishers')).send({ name: `${NAME.toUpperCase()} press ` });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_PUBLISHER');
  });

  describe('lifecycle', () => {
    it('refuses to activate an archived author; it must be restored (was: 200)', async () => {
      const id = await create('authors', { name: `${NAME} Archived Author` });
      expect((await as(api().post(`/api/v1/authors/${id}/archive`))).status).toBe(200);
      const res = await as(api().post(`/api/v1/authors/${id}/activate`));
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INVALID_LIFECYCLE_TRANSITION');
      expect((await as(api().post(`/api/v1/authors/${id}/restore`))).status).toBe(200);
    });

    it('refuses to restore a record that is not archived (was: 200, set active)', async () => {
      const id = await create('publishers', { name: `${NAME} Inactive Publisher` });
      expect((await as(api().post(`/api/v1/publishers/${id}/deactivate`))).status).toBe(200);
      const res = await as(api().post(`/api/v1/publishers/${id}/restore`));
      expect(res.status).toBe(422);
      const row = (await db.query(`SELECT status FROM publishers WHERE id = $1`, [id])).rows[0];
      expect(row.status).toBe('INACTIVE');
    });

    it('changes nothing and writes no audit entry when the status repeats (was: an entry each time)', async () => {
      const id = await create('categories', { name: `${NAME} Twice Archived` });
      expect((await as(api().post(`/api/v1/categories/${id}/archive`))).status).toBe(200);
      expect((await as(api().post(`/api/v1/categories/${id}/archive`))).status).toBe(200);
      expect(await auditCount('category', id, 'ARCHIVE')).toBe(1);
    });
  });
});
