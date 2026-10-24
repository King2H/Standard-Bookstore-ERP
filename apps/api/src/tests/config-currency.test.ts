import { createRequire } from 'node:module';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { ownerDb } from './helpers/ownerDb.js';
import { cleanBranchConfig, cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';
import { DEFAULT_ADMIN_PASSWORD_HASH } from '../db/seed.js';

// The shop's currency is one setting for every branch: a fresh install starts
// in ETB, the currency every amount is recorded in (1a); no branch overrides
// it (2a); Super_Admin changes it only while no money is recorded, as amounts
// are never converted (3a). Since #181 a draft purchase order holds it too
// (shop-currency.test.ts).

const PREFIX = 'cfgcur_test_';
const BRANCH_PREFIX = 'Config Currency ';
const TENANT_NAME = 'Config Currency Test Tenant';

describe('The base currency', () => {
  let branchId: number;
  let superAdmin: string;
  let manager: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  async function cleanUpTenant() {
    const owner = ownerDb();
    const tenant = `SELECT id FROM tenants WHERE name = '${TENANT_NAME}'`;
    await owner.query(`DELETE FROM refresh_tokens WHERE session_id IN (SELECT id FROM staff_sessions WHERE tenant_id IN (${tenant}))`);
    for (const table of [
      'audit_logs', 'outbox', 'orders', 'purchase_orders', 'suppliers', 'system_config', 'staff_branch_roles', 'staff_sessions', 'staff', 'branches',
    ]) {
      await owner.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenant})`);
    }
    await owner.query(`DELETE FROM tenants WHERE name = '${TENANT_NAME}'`);
  }

  beforeAll(async () => {
    await cleanUpTenant();
    await cleanTestStaff(PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
    superAdmin = (await createTestStaff({ username: `${PREFIX}sa`, role: 'Super_Admin', branchId })).token;
    manager = (await createTestStaff({ username: `${PREFIX}mgr`, role: 'Manager', branchId })).token;
  });

  afterAll(async () => {
    await cleanBranchConfig(branchId);
    await cleanUpTenant();
    await cleanTestStaff(PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  describe('on a fresh install (1a)', () => {
    it('is ETB, the currency amounts are recorded in (was: USD from the first config migration)', async () => {
      const res = await as(api().get('/api/v1/config/currency'), superAdmin);
      expect(res.body).toEqual({ currency: 'ETB' });
    });

    it('is corrected by the migration only where it is still the seeded USD, audited; a chosen currency stays', async () => {
      const migration = createRequire(import.meta.url)('../db/migrations/1700000074_base_currency_global.cjs') as {
        up: (pgm: { sql: (s: string) => void }) => void;
      };
      const client = await ownerDb().connect();
      const run = async () => {
        const statements: string[] = [];
        migration.up({ sql: (s) => statements.push(s) });
        for (const s of statements) await client.query(s);
      };
      try {
        await client.query('BEGIN');
        const tenant = async (name: string) => (await client.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [name])).rows[0].id as number;
        const seeded = await tenant(`${TENANT_NAME} seeded`);
        const chosen = await tenant(`${TENANT_NAME} chosen`);
        for (const t of [seeded, chosen]) {
          await client.query(`INSERT INTO system_config (tenant_id, key, value, updated_by) VALUES ($1, 'base_currency', '"USD"', 1)`, [t]);
        }
        // Someone chose USD in Settings, which audits the change.
        await client.query(
          `INSERT INTO audit_logs (tenant_id, staff_id, staff_role, action, entity_type, entity_id, meta)
           VALUES ($1, NULL, 'Super_Admin', 'UPDATE', 'system_config', 'base_currency', '{"newValue":"USD"}')`,
          [chosen],
        );
        await client.query(
          `INSERT INTO branch_config (tenant_id, branch_id, key, value, updated_by) VALUES (1, $1, 'base_currency', '"USD"', 1)`,
          [branchId],
        );

        await run();
        await run();

        const currency = async (t: number) => (await client.query(
          `SELECT value FROM system_config WHERE tenant_id = $1 AND key = 'base_currency'`, [t],
        )).rows[0].value;
        expect([await currency(seeded), await currency(chosen)]).toEqual(['ETB', 'USD']);
        const corrected = (await client.query(
          `SELECT staff_id, action, meta FROM audit_logs WHERE tenant_id = $1 AND entity_type = 'system_config'`, [seeded],
        )).rows;
        expect(corrected).toEqual([{
          staff_id: null, action: 'UPDATE', meta: expect.objectContaining({ key: 'base_currency', previousValue: 'USD', newValue: 'ETB' }),
        }]);

        expect((await client.query(`SELECT 1 FROM branch_config WHERE branch_id = $1 AND key = 'base_currency'`, [branchId])).rows).toEqual([]);
        const removed = (await client.query(
          `SELECT staff_id, action, branch_id, meta FROM audit_logs WHERE entity_type = 'branch_config' AND branch_id = $1`, [branchId],
        )).rows;
        expect(removed).toEqual([{
          staff_id: null, action: 'DELETE', branch_id: branchId,
          meta: expect.objectContaining({ key: 'base_currency', action: 'override_removed', previousValue: 'USD' }),
        }]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('for every branch (2a)', () => {
    it('refuses a branch override of the currency (was: saved, and the branch showed its amounts in another currency)', async () => {
      for (const token of [superAdmin, manager]) {
        const res = await as(api().put(`/api/v1/config/branches/${branchId}/base_currency`), token).send({ value: 'USD' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('VALIDATION_ERROR');
      }
      expect((await db.query(`SELECT 1 FROM branch_config WHERE branch_id = $1 AND key = 'base_currency'`, [branchId])).rows).toEqual([]);
    });

    it('ignores an override saved before, everywhere the currency is read', async () => {
      await db.query(`INSERT INTO branch_config (branch_id, key, value, updated_by) VALUES ($1, 'base_currency', '"USD"', 1)`, [branchId]);
      try {
        expect((await as(api().get('/api/v1/config/currency'), superAdmin)).body).toEqual({ currency: 'ETB' });
        const effective = await as(api().get('/api/v1/config/effective?keys=base_currency'), superAdmin);
        expect(effective.body.items).toEqual([expect.objectContaining({ key: 'base_currency', value: 'ETB', source: 'system' })]);
        const branch = await as(api().get(`/api/v1/config/branches/${branchId}`), superAdmin);
        expect(branch.body.items).toContainEqual(expect.objectContaining({ key: 'base_currency', value: 'ETB', source: 'system' }));
      } finally {
        await cleanBranchConfig(branchId);
      }
    });

    it('takes only a three-letter ISO 4217 code', async () => {
      for (const value of ['Birr', 'etb', 'ET', '']) {
        const res = await as(api().put('/api/v1/config/system/base_currency'), superAdmin).send({ value });
        expect(res.status).toBe(400);
      }
    });
  });

  describe('changed by Super_Admin (3a)', () => {
    it('changes while no money is recorded, and is refused once it is (amounts are never converted)', async () => {
      const owner = ownerDb();
      const tenant = (await owner.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [TENANT_NAME])).rows[0].id;
      const branch = (await owner.query(
        `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, 'Main Branch', '-', '{}', '{}') RETURNING id`,
        [tenant],
      )).rows[0].id;
      const staff = (await owner.query(
        `INSERT INTO staff (tenant_id, username, password_hash, full_name, is_active, must_change_password)
         VALUES ($1, $2, $3, 'Currency Test', true, false) RETURNING id`,
        [tenant, `${PREFIX}tenant_sa`, DEFAULT_ADMIN_PASSWORD_HASH],
      )).rows[0].id;
      await owner.query(`INSERT INTO staff_branch_roles (tenant_id, staff_id, branch_id, role) VALUES ($1, $2, $3, 'Super_Admin')`, [tenant, staff, branch]);
      await owner.query(`INSERT INTO system_config (tenant_id, key, value, updated_by) VALUES ($1, 'base_currency', '"ETB"', $2)`, [tenant, staff]);
      const login = await api().post('/api/v1/auth/login').send({ username: `${PREFIX}tenant_sa`, password: 'Admin@1234', branchId: branch });
      expect(login.status).toBe(200);
      const token = login.body.accessToken as string;
      const setCurrency = (value: string) => as(api().put('/api/v1/config/system/base_currency'), token).send({ value });

      expect((await setCurrency('USD')).status).toBe(200);
      expect((await as(api().get('/api/v1/config/currency'), token)).body).toEqual({ currency: 'USD' });

      await owner.query(
        `INSERT INTO orders (tenant_id, order_number, branch_id, created_by, currency) VALUES ($1, $2, $3, $4, 'USD')`, [tenant, `${PREFIX}1`, branch, staff],
      );
      const refused = await setCurrency('ETB');
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('CURRENCY_IN_USE');
      expect((await as(api().get('/api/v1/config/currency'), token)).body).toEqual({ currency: 'USD' });
      // Saving the same currency again changes nothing, so it is not refused.
      expect((await setCurrency('USD')).status).toBe(200);
    });
  });
});
