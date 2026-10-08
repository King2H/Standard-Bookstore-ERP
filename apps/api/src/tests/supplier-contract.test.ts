import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { SupplierListResponseSchema, SupplierSchema, SupplierUsageSchema } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff } from './helpers/testDb.js';
import { createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Behaviour the Suppliers pilot (#19) adds on top of supplier.test.ts:
// responses follow the shared contracts and requests are validated by them.

const STAFF_PREFIX = 'supc_test_';
const NAME_PREFIX = 'Contract Supplier';

async function cleanSuppliers() {
  await db.query(`DELETE FROM audit_logs WHERE entity_type = 'supplier' AND entity_id IN (SELECT id::text FROM suppliers WHERE name LIKE $1)`, [`${NAME_PREFIX}%`]);
  await db.query(`DELETE FROM suppliers WHERE name LIKE $1`, [`${NAME_PREFIX}%`]);
}

describe('Suppliers on the shared contracts', () => {
  let token: string;
  const api = () => request(getTestApp());
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

  async function createSupplier(name: string): Promise<number> {
    const res = await auth(api().post('/api/v1/suppliers')).send({
      name,
      contactInfo: { phone: '0911000000' },
      supplierType: 'external',
    });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanSuppliers();
    token = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId: 1 })).token;
  });

  afterAll(async () => {
    await cleanSuppliers();
    await cleanTestStaff(STAFF_PREFIX);
  });

  it('returns suppliers and lists in the shape of the shared schemas', async () => {
    const id = await createSupplier(`${NAME_PREFIX} Shape`);

    const one = await auth(api().get(`/api/v1/suppliers/${id}`));
    expect(SupplierSchema.strict().parse(one.body)).toEqual(one.body);
    expect(one.body).toMatchObject({ leadTimeDays: 7, pricingTerms: null, status: 'ACTIVE', archivedAt: null });

    const list = await auth(api().get(`/api/v1/suppliers?q=${encodeURIComponent(`${NAME_PREFIX} Shape`)}`));
    expect(SupplierListResponseSchema.strict().parse(list.body)).toEqual(list.body);
    expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 25, totalPages: 1 });
  });

  it('rejects an invalid body with 400 VALIDATION_ERROR instead of a database error', async () => {
    const res = await auth(api().post('/api/v1/suppliers')).send({ supplierType: 'wholesale', leadTimeDays: 'soon' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    const paths = (res.body.details.issues as { path: string[] }[]).map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['body.name', 'body.contactInfo', 'body.supplierType', 'body.leadTimeDays']));
  });

  it('rejects a non-numeric id with 400', async () => {
    const res = await auth(api().get('/api/v1/suppliers/abc'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('caps pageSize at 100 instead of rejecting it (the procurement picker asks for 200)', async () => {
    const res = await auth(api().get('/api/v1/suppliers?isActive=true&isBlacklisted=false&pageSize=200'));
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(100);
  });

  it('refuses renaming a supplier to an existing name with 409 DUPLICATE_SUPPLIER_NAME', async () => {
    await createSupplier(`${NAME_PREFIX} Taken`);
    const id = await createSupplier(`${NAME_PREFIX} Rename`);

    const res = await auth(api().put(`/api/v1/suppliers/${id}`)).send({ name: `${NAME_PREFIX} Taken` });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_SUPPLIER_NAME');
  });

  it('archives and restores a supplier, keeping is_active in step and auditing each step', async () => {
    const id = await createSupplier(`${NAME_PREFIX} Lifecycle`);
    const get = async () => (await auth(api().get(`/api/v1/suppliers/${id}`))).body;

    expect((await auth(api().post(`/api/v1/suppliers/${id}/archive`))).body).toEqual({ message: 'Supplier archived' });
    expect(await get()).toMatchObject({ status: 'ARCHIVED', isActive: false, archivedAt: expect.any(String) });

    const archived = await auth(api().get(`/api/v1/suppliers?status=archived&q=${encodeURIComponent(`${NAME_PREFIX} Lifecycle`)}`));
    expect(archived.body.items.map((s: { id: number }) => s.id)).toEqual([id]);

    await auth(api().post(`/api/v1/suppliers/${id}/restore`));
    expect(await get()).toMatchObject({ status: 'ACTIVE', isActive: true, archivedAt: null });

    const audit = await db.query(
      `SELECT action, meta FROM audit_logs WHERE entity_type = 'supplier' AND entity_id = $1 ORDER BY id`,
      [String(id)],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['CREATE', 'ARCHIVE', 'RESTORE']);
    expect(audit.rows[1].meta).toEqual({ previousStatus: 'ACTIVE', newStatus: 'ARCHIVED' });
  });

  it('returns 404 for lifecycle actions on a missing supplier', async () => {
    const res = await auth(api().post('/api/v1/suppliers/999999/archive'));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('reports usage in the shape of the shared schema', async () => {
    const id = await createSupplier(`${NAME_PREFIX} Usage`);
    const res = await auth(api().get(`/api/v1/suppliers/${id}/usage`));
    expect(res.status).toBe(200);
    expect(SupplierUsageSchema.strict().parse(res.body)).toEqual({ purchaseOrders: 0 });
  });
});
