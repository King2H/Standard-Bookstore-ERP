/**
 * services.test.ts
 *
 * #169 PR 1 (owner decisions 1a, 2a, 3a, 4a, 2026-10-25): the services list,
 * non-stock items a sale will carry next to its books (binding first). Each
 * service names the cover it produces, a fee, a standard cost, whether the
 * fee may be discounted and its turnaround. Admin and Manager change the list
 * (1a); a branch overrides the fee only (2a); codes are typed, unique ignoring
 * case, and the catalog's lifecycle rule applies (4a). Before, there was no
 * services list at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'services_test_';
const BRANCH_PREFIX = 'Services ';
const CODE = 'SVCTEST';

describe('Services list', () => {
  let branchId: number;
  let otherBranch: number;
  let formatId: number;
  let manager: string;
  let otherManager: string;
  let admin: string;
  let clerk: string;
  let sales: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = manager, branch = branchId) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branch));
  const valid = (over: object = {}) => ({
    code: `${CODE}-LEATHER`, name: 'Leather binding', formatId, fee: 250, standardCost: 120, discountable: false, turnaroundDays: 5, ...over,
  });
  const create = (body: object, token = manager) => as(api().post('/api/v1/services'), token).send(body);

  async function cleanUp() {
    await db.query(`DELETE FROM service_branch_fees WHERE service_id IN (SELECT id FROM services WHERE code LIKE '${CODE}%')`);
    await db.query(`DELETE FROM services WHERE code LIKE '${CODE}%'`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    otherBranch = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    otherManager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr_b`, role: 'Manager', branchId: otherBranch })).token;
    admin = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId })).token;
    clerk = (await createTestStaff({ username: `${STAFF_PREFIX}clerk`, role: 'Stock_Clerk', branchId })).token;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    formatId = (await db.query(`SELECT id FROM book_formats WHERE tenant_id = 1 ORDER BY id LIMIT 1`)).rows[0].id;
  });

  afterAll(cleanUp);

  describe('creating and changing a service (1a, 4a)', () => {
    let id: number;

    it('lets a Manager add a binding service with its cover, fee, cost and turnaround, audited (was: no services list)', async () => {
      const res = await create(valid({ code: `${CODE}-leather` }));
      expect(res.status).toBe(201);
      id = res.body.id;
      expect(res.body).toMatchObject({
        code: `${CODE}-LEATHER`, name: 'Leather binding', kind: 'binding', formatId, fee: 250, branchFee: null, effectiveFee: 250,
        standardCost: 120, discountable: false, turnaroundDays: 5, status: 'ACTIVE',
      });
      expect(res.body.formatLabel).toEqual(expect.any(String));
      const audit = (await db.query(`SELECT action, meta FROM audit_logs WHERE entity_type = 'service' AND entity_id = $1`, [String(id)])).rows;
      expect(audit).toEqual([expect.objectContaining({ action: 'CREATE' })]);
    });

    it('keeps codes unique ignoring case', async () => {
      const res = await create(valid({ code: `${CODE}-Leather`, name: 'Another' }));
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('DUPLICATE_SERVICE');
    });

    it('checks the fee, cost, turnaround and cover', async () => {
      for (const bad of [{ fee: 0 }, { fee: -5 }, { standardCost: -1 }, { turnaroundDays: -1 }, { turnaroundDays: 1.5 }, { code: '' }, { name: '  ' }, { formatId: undefined }]) {
        const res = await create(valid({ code: `${CODE}-BAD`, ...bad }));
        expect(res.status, JSON.stringify(bad)).toBe(400);
      }
      const unknown = await create(valid({ code: `${CODE}-BAD`, formatId: 999999 }));
      expect(unknown.status).toBe(404);
    });

    it('lets an Admin change a service, audited', async () => {
      const res = await as(api().put(`/api/v1/services/${id}`), admin).send(valid({ name: 'Leather binding, gilt', fee: 275, discountable: true }));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: 'Leather binding, gilt', fee: 275, effectiveFee: 275, discountable: true });
      const actions = (await db.query(`SELECT action FROM audit_logs WHERE entity_type = 'service' AND entity_id = $1 ORDER BY id`, [String(id)])).rows;
      expect(actions.map((a) => a.action)).toEqual(['CREATE', 'UPDATE']);
    });

    it('is for Admin and Manager only; every role reads it (1a, 3a)', async () => {
      expect((await create(valid({ code: `${CODE}-CLERK` }), clerk)).status).toBe(403);
      expect((await create(valid({ code: `${CODE}-SALES` }), sales)).status).toBe(403);
      expect((await as(api().put(`/api/v1/services/${id}`), clerk).send(valid())).status).toBe(403);
      const read = await as(api().get(`/api/v1/services?q=${CODE}`), sales);
      expect(read.status).toBe(200);
      expect(read.body.items.map((s: { id: number }) => s.id)).toContain(id);
    });

    it('follows the catalog lifecycle: archived comes back only by restore, and lists show active ones unless asked', async () => {
      const deactivated = await as(api().post(`/api/v1/services/${id}/deactivate`));
      expect(deactivated.body.status).toBe('INACTIVE');
      expect((await as(api().get(`/api/v1/services?q=${CODE}`))).body.items).toEqual([]);
      expect((await as(api().get(`/api/v1/services?q=${CODE}&status=inactive`))).body.items).toHaveLength(1);
      expect((await as(api().post(`/api/v1/services/${id}/archive`))).body.status).toBe('ARCHIVED');
      const refused = await as(api().post(`/api/v1/services/${id}/activate`));
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('INVALID_LIFECYCLE_TRANSITION');
      expect((await as(api().post(`/api/v1/services/${id}/restore`))).body.status).toBe('ACTIVE');
      expect((await as(api().post(`/api/v1/services/${id}/archive`), clerk)).status).toBe(403);
    });
  });

  describe('a branch fee (2a)', () => {
    let id: number;

    beforeAll(async () => {
      id = (await create(valid({ code: `${CODE}-CLOTH`, name: 'Cloth binding', fee: 150, standardCost: 60 }))).body.id;
    });

    it('lets a Manager set the fee for their session branch only; the standard cost stays one for the shop', async () => {
      const res = await as(api().put(`/api/v1/services/${id}/branch-fee`)).send({ fee: 180 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ fee: 150, branchFee: 180, effectiveFee: 180, standardCost: 60 });
      const elsewhere = await as(api().get(`/api/v1/services/${id}`), otherManager, otherBranch);
      expect(elsewhere.body).toMatchObject({ fee: 150, branchFee: null, effectiveFee: 150 });
      const audit = await db.query(`SELECT meta FROM audit_logs WHERE entity_type = 'service' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [String(id)]);
      expect(audit.rows[0].meta).toMatchObject({ branchId, branchFee: 180 });
    });

    it('lists the effective fee of the session branch', async () => {
      const res = await as(api().get(`/api/v1/services?q=${CODE}-CLOTH`));
      expect(res.body.items[0]).toMatchObject({ branchFee: 180, effectiveFee: 180 });
    });

    it('removes the branch fee, back to the shop fee', async () => {
      const res = await as(api().delete(`/api/v1/services/${id}/branch-fee`));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ branchFee: null, effectiveFee: 150 });
    });

    it('checks the fee and refuses the other roles', async () => {
      expect((await as(api().put(`/api/v1/services/${id}/branch-fee`)).send({ fee: 0 })).status).toBe(400);
      expect((await as(api().put(`/api/v1/services/${id}/branch-fee`), clerk).send({ fee: 10 })).status).toBe(403);
      expect((await as(api().put(`/api/v1/services/9999999/branch-fee`)).send({ fee: 10 })).status).toBe(404);
    });
  });
});
