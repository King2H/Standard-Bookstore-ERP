import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { sql } from 'kysely';
import { getTestApp } from './helpers/testApp.js';
import { db } from '../db/index.js';
import { ownerDb } from './helpers/ownerDb.js';
import { kysely } from '../db/kysely.js';
import { DEFAULT_ADMIN_PASSWORD_HASH, ensureSeedData } from '../db/seed.js';
import { runInTenant, setFallbackTenant } from '../db/tenantContext.js';
import { forEachTenant } from '../db/tenants.js';
import { withTransaction } from '../db/tx.js';

// #13, part 2: the tenant of every piece of work comes from the signed-in
// account (or the background job's tenant), never from the client, and every
// database connection it uses carries it. These tests switch off the test
// fallback tenant, so work that loses its tenant fails here. Fixtures for
// the second tenant are written by the owner.

const PREFIX = 'tenant_ctx_test_';
const TENANT_NAME = 'Tenant Context Test B';
const PASSWORD = 'Admin@1234'; // DEFAULT_ADMIN_PASSWORD_HASH

const tenantSetting = async () =>
  (await sql<{ tenant: string | null }>`SELECT current_setting('app.tenant_id', true) AS tenant`.execute(kysely)).rows[0].tenant ?? '';

describe('Tenant context', () => {
  let tenantB: number;
  let branchB: number;
  let staffB: number;
  const api = () => request(getTestApp());

  async function cleanUp() {
    const tenant = `SELECT id FROM tenants WHERE name = '${TENANT_NAME}'`;
    for (const table of [
      'audit_logs', 'outbox', 'loyalty_accounts', 'store_credit_accounts', 'customers', 'document_counters',
      'staff_branch_roles', 'staff_sessions', 'staff', 'locations', 'branches',
    ]) {
      if (table === 'staff_sessions') await ownerDb().query(`DELETE FROM refresh_tokens WHERE session_id IN (SELECT id FROM staff_sessions WHERE tenant_id IN (${tenant}))`);
      await ownerDb().query(`DELETE FROM ${table} WHERE tenant_id IN (${tenant})`);
    }
    await ownerDb().query(`DELETE FROM tenants WHERE name = '${TENANT_NAME}'`);
  }

  beforeAll(async () => {
    await cleanUp();
    tenantB = (await ownerDb().query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [TENANT_NAME])).rows[0].id;
    branchB = (await ownerDb().query(
      `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, 'Main Branch', '-', '{}', '{}') RETURNING id`,
      [tenantB],
    )).rows[0].id;
    staffB = (await ownerDb().query(
      `INSERT INTO staff (tenant_id, username, password_hash, full_name, is_active, must_change_password)
       VALUES ($1, $2, $3, 'Tenant B Manager', true, false) RETURNING id`,
      [tenantB, `${PREFIX}mgr`, DEFAULT_ADMIN_PASSWORD_HASH],
    )).rows[0].id;
    await ownerDb().query(`INSERT INTO staff_branch_roles (tenant_id, staff_id, branch_id, role) VALUES ($1, $2, $3, 'Manager')`, [tenantB, staffB, branchB]);
    // From here on, work with no tenant has none.
    setFallbackTenant(undefined);
  });

  afterAll(async () => {
    setFallbackTenant(1);
    await cleanUp();
  });

  describe('database connections', () => {
    it('carry the tenant of the work that checks them out, and never the previous one\'s', async () => {
      expect(await runInTenant(7, tenantSetting)).toBe('7');
      expect(await runInTenant(8, () => withTransaction({}, async (tx) =>
        (await sql<{ tenant: string }>`SELECT current_setting('app.tenant_id', true) AS tenant`.execute(tx)).rows[0].tenant,
      ))).toBe('8');
      expect(await runInTenant(9, async () => (await db.query(`SELECT current_setting('app.tenant_id', true) AS tenant`)).rows[0].tenant)).toBe('9');
      expect(await tenantSetting()).toBe('');
    });

    it('keep work running at the same time in its own tenant', async () => {
      const seen = await Promise.all([1, 2, 3, 4, 5, 6].map((t) => runInTenant(t, async () => {
        await new Promise((r) => setTimeout(r, 10 * (6 - t)));
        return tenantSetting();
      })));
      expect(seen).toEqual(['1', '2', '3', '4', '5', '6']);
    });

    it('refuse a new row written with no tenant (was: it landed in tenant 1)', async () => {
      // Row-level security refuses it before the missing tenant_id would.
      await expect(db.query(`INSERT INTO customer_groups (name) VALUES ($1)`, [`${PREFIX}no tenant`]))
        .rejects.toMatchObject({ code: '42501' });
    });

    it('write a new row to the tenant of the work', async () => {
      const { rows } = await runInTenant(tenantB, () => db.query(
        `INSERT INTO customer_groups (name) VALUES ($1) RETURNING tenant_id`, [`${PREFIX}group`],
      ));
      expect(rows).toEqual([{ tenant_id: tenantB }]);
      await runInTenant(tenantB, () => db.query(`DELETE FROM customer_groups WHERE name = $1`, [`${PREFIX}group`]));
    });
  });

  describe('a signed-in account', () => {
    let token: string;
    let cookie: string;

    it('signs in to its own tenant, which the token names', async () => {
      const pre = await api().post('/api/v1/auth/pre-login').send({ username: `${PREFIX}MGR`, password: PASSWORD });
      expect(pre.status).toBe(200);
      expect(pre.body.branches).toEqual([expect.objectContaining({ branchId: branchB })]);

      const res = await api().post('/api/v1/auth/login').send({ username: `${PREFIX}mgr`, password: PASSWORD, branchId: branchB });
      expect(res.status).toBe(200);
      token = res.body.accessToken;
      cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refreshToken='))!.split(';')[0];
      expect(jwt.decode(token)).toMatchObject({ staffId: staffB, branchId: branchB, tenantId: tenantB });

      const { rows } = await runInTenant(tenantB, () => db.query(`SELECT tenant_id FROM staff_sessions WHERE staff_id = $1`, [staffB]));
      expect(rows).toEqual([{ tenant_id: tenantB }]);
    });

    it('writes to its own tenant, numbering documents per tenant', async () => {
      const res = await api().post('/api/v1/customers').set('Authorization', `Bearer ${token}`).send({ fullName: 'Tenant B Customer' });
      expect(res.status).toBe(201);
      // Tenant 1 has its own customers; tenant B's series starts at 1.
      expect(res.body.customerCode).toBe('CUS-0001');
      const { rows } = await runInTenant(tenantB, () => db.query(`SELECT tenant_id FROM customers WHERE id = $1`, [res.body.id]));
      expect(rows).toEqual([{ tenant_id: tenantB }]);
    });

    it('refreshes in its own tenant', async () => {
      const res = await api().post('/api/v1/auth/refresh').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(jwt.decode(res.body.accessToken)).toMatchObject({ staffId: staffB, tenantId: tenantB });
    });

    it('fails a sign-in with a wrong password the same way, in its tenant', async () => {
      const res = await api().post('/api/v1/auth/login').send({ username: `${PREFIX}mgr`, password: 'wrong', branchId: branchB });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('INVALID_CREDENTIALS');
      const { rows } = await runInTenant(tenantB, () => db.query(`SELECT failed_login_attempts FROM staff WHERE id = $1`, [staffB]));
      expect(rows[0].failed_login_attempts).toBe(1);
    });

    it('answers an unknown username as a wrong password', async () => {
      const res = await api().post('/api/v1/auth/login').send({ username: `${PREFIX}nobody`, password: PASSWORD, branchId: branchB });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('background work', () => {
    it('runs once in each active tenant', async () => {
      const seen: Array<[number, string]> = [];
      await forEachTenant('test job', async (tenantId) => {
        seen.push([tenantId, await tenantSetting()]);
      });
      expect(seen).toContainEqual([1, '1']);
      expect(seen).toContainEqual([tenantB, String(tenantB)]);
    });

    it('seeds the default tenant at startup', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await ensureSeedData();
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    });
  });
});
