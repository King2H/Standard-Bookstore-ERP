import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff } from './helpers/testDb.js';
import { createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #96: suppliers and customers follow the catalog's lifecycle rules. An
// archived record comes back only by restore, only an archived record is
// restored, and a repeated status changes nothing and writes no audit entry.

const STAFF_PREFIX = 'lifecycle_test_';
const SUPPLIER_PREFIX = 'Lifecycle Test Supplier';
const CUSTOMER_PREFIX = 'LIFECYCLE-';

describe('Supplier and customer lifecycle', () => {
  let token: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', '1');

  const audits = async (entityType: string, id: number): Promise<number> =>
    Number((await db.query(`SELECT count(*) FROM audit_logs WHERE entity_type = $1 AND entity_id = $2`, [entityType, String(id)])).rows[0].count);

  async function supplier(status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED'): Promise<number> {
    const n = Math.random().toString(36).slice(2, 8);
    return (await db.query(
      `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type, status, is_active)
       VALUES ($1, '{}', 7, 'external', $2, $3) RETURNING id`,
      [`${SUPPLIER_PREFIX} ${n}`, status, status === 'ACTIVE'],
    )).rows[0].id;
  }

  async function customer(status: 'ACTIVE' | 'ARCHIVED'): Promise<number> {
    const n = Math.random().toString(36).slice(2, 8);
    return (await db.query(
      `INSERT INTO customers (full_name, customer_code, is_active, status) VALUES ('Lifecycle Test', $1, $2, $3) RETURNING id`,
      [`${CUSTOMER_PREFIX}${n}`, status === 'ACTIVE', status],
    )).rows[0].id;
  }

  async function cleanUp() {
    await db.query(`DELETE FROM audit_logs WHERE entity_type = 'supplier' AND entity_id IN (SELECT id::text FROM suppliers WHERE name LIKE $1)`, [`${SUPPLIER_PREFIX}%`]);
    await db.query(`DELETE FROM suppliers WHERE name LIKE $1`, [`${SUPPLIER_PREFIX}%`]);
    await db.query(`DELETE FROM audit_logs WHERE entity_type = 'customer' AND entity_id IN (SELECT id::text FROM customers WHERE customer_code LIKE $1)`, [`${CUSTOMER_PREFIX}%`]);
    await db.query(`DELETE FROM customers WHERE customer_code LIKE $1`, [`${CUSTOMER_PREFIX}%`]);
    await cleanTestStaff(STAFF_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    token = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId: 1 })).token;
  });

  afterAll(cleanUp);

  describe('suppliers', () => {
    it('refuses to activate an archived supplier without restoring it (was: 200)', async () => {
      const id = await supplier('ARCHIVED');
      const res = await as(api().post(`/api/v1/suppliers/${id}/activate`));
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INVALID_LIFECYCLE_TRANSITION');
      expect((await db.query(`SELECT status FROM suppliers WHERE id = $1`, [id])).rows[0].status).toBe('ARCHIVED');
    });

    it('refuses to restore a supplier that is not archived (was: 200)', async () => {
      const id = await supplier('INACTIVE');
      const res = await as(api().post(`/api/v1/suppliers/${id}/restore`));
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INVALID_LIFECYCLE_TRANSITION');
    });

    it('changes nothing and writes no audit entry on a repeat (was: one entry each time)', async () => {
      const id = await supplier('ACTIVE');
      expect((await as(api().post(`/api/v1/suppliers/${id}/deactivate`))).status).toBe(200);
      expect((await as(api().post(`/api/v1/suppliers/${id}/deactivate`))).status).toBe(200);
      expect(await audits('supplier', id)).toBe(1);
    });

    it('restores an archived supplier to active', async () => {
      const id = await supplier('ARCHIVED');
      expect((await as(api().post(`/api/v1/suppliers/${id}/restore`))).status).toBe(200);
      const row = (await db.query(`SELECT status, is_active, archived_at FROM suppliers WHERE id = $1`, [id])).rows[0];
      expect(row).toEqual({ status: 'ACTIVE', is_active: true, archived_at: null });
    });
  });

  describe('customers', () => {
    it('refuses to deactivate an archived customer (was: 200, and the archive was undone)', async () => {
      const id = await customer('ARCHIVED');
      const res = await as(api().post(`/api/v1/customers/${id}/deactivate`));
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INVALID_LIFECYCLE_TRANSITION');
      expect((await db.query(`SELECT status FROM customers WHERE id = $1`, [id])).rows[0].status).toBe('ARCHIVED');
    });

    it('deactivates once: a repeat writes no audit entry (was: one entry each time)', async () => {
      const id = await customer('ACTIVE');
      expect((await as(api().post(`/api/v1/customers/${id}/deactivate`))).status).toBe(200);
      expect((await as(api().post(`/api/v1/customers/${id}/deactivate`))).status).toBe(200);
      expect(await audits('customer', id)).toBe(1);
      const row = (await db.query(`SELECT status, is_active FROM customers WHERE id = $1`, [id])).rows[0];
      expect(row).toEqual({ status: 'INACTIVE', is_active: false });
    });
  });
});
