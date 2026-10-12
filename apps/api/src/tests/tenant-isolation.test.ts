import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { ownerDb } from './helpers/ownerDb.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db, appRoleProblem } from '../db/index.js';
import { DEFAULT_ADMIN_PASSWORD_HASH } from '../db/seed.js';
import { runInTenant, setFallbackTenant } from '../db/tenantContext.js';

// #13, part 3: row-level security keeps tenants apart even where the
// application does not filter. The API (and these tests) work as a user it
// applies to; a second tenant's admin must never see, find or change the
// first tenant's rows.

const PREFIX = 'tenant_iso_test_';
const TENANT_NAME = 'Tenant Isolation Test B';
const PASSWORD = 'Admin@1234'; // DEFAULT_ADMIN_PASSWORD_HASH
const NEW_PASSWORD = 'Temp#2026pass';
const PHONE = '0911555333';

describe('Tenant isolation', () => {
  let tenantB: number;
  let branchB: number;
  let tokenB: string;
  let customerA: number;
  let bookA: { id: number; title: string };
  const api = () => request(getTestApp());
  const asB = (req: request.Test) => req.set('Authorization', `Bearer ${tokenB}`);

  async function cleanUp() {
    const owner = ownerDb();
    const tenant = `SELECT id FROM tenants WHERE name = '${TENANT_NAME}'`;
    await owner.query(`DELETE FROM refresh_tokens WHERE session_id IN (SELECT id FROM staff_sessions WHERE tenant_id IN (${tenant}))`);
    for (const table of [
      'audit_logs', 'outbox', 'loyalty_accounts', 'store_credit_accounts', 'customers', 'document_counters',
      'staff_branch_roles', 'staff_sessions', 'staff', 'locations', 'branches',
    ]) {
      await owner.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenant})`);
    }
    await owner.query(`DELETE FROM tenants WHERE name = '${TENANT_NAME}'`);
    await owner.query(`DELETE FROM loyalty_accounts WHERE customer_id IN (SELECT id FROM customers WHERE full_name LIKE '${PREFIX}%')`);
    await owner.query(`DELETE FROM store_credit_accounts WHERE customer_id IN (SELECT id FROM customers WHERE full_name LIKE '${PREFIX}%')`);
    await owner.query(`DELETE FROM customers WHERE full_name LIKE '${PREFIX}%'`);
    await cleanTestStaff(PREFIX);
    await cleanTestBranches('Tenant Iso Test ');
  }

  beforeAll(async () => {
    await cleanUp();
    const owner = ownerDb();
    tenantB = (await owner.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [TENANT_NAME])).rows[0].id;
    branchB = (await owner.query(
      `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, 'Main Branch', '-', '{}', '{}') RETURNING id`,
      [tenantB],
    )).rows[0].id;
    const staffB = (await owner.query(
      `INSERT INTO staff (tenant_id, username, password_hash, full_name, is_active, must_change_password)
       VALUES ($1, $2, $3, 'Tenant B Admin', true, false) RETURNING id`,
      [tenantB, `${PREFIX}admin`, DEFAULT_ADMIN_PASSWORD_HASH],
    )).rows[0].id;
    await owner.query(`INSERT INTO staff_branch_roles (tenant_id, staff_id, branch_id, role) VALUES ($1, $2, $3, 'Admin')`, [tenantB, staffB, branchB]);

    // Tenant 1's customer, through the API as a tenant 1 manager.
    const branchA = (await createTestBranch({ name: 'Tenant Iso Test A' })).branchId;
    const managerA = await createTestStaff({ username: `${PREFIX}mgr_a`, role: 'Manager', branchId: branchA });
    const created = await api().post('/api/v1/customers').set('Authorization', `Bearer ${managerA.token}`)
      .send({ fullName: `${PREFIX}tenant 1 customer`, phone: PHONE });
    expect(created.status).toBe(201);
    customerA = created.body.id;
    bookA = (await db.query(`SELECT id, title FROM books WHERE is_active = true ORDER BY id LIMIT 1`)).rows[0];

    const res = await api().post('/api/v1/auth/login').send({ username: `${PREFIX}admin`, password: PASSWORD, branchId: branchB });
    expect(res.status).toBe(200);
    tokenB = res.body.accessToken;
  });

  afterAll(cleanUp);

  describe('the database', () => {
    it('is used by the API as a user row-level security applies to', async () => {
      expect(await appRoleProblem()).toBeUndefined();
    });

    it("shows a tenant's work none of another tenant's rows, in any table", async () => {
      const { rows: tables } = await ownerDb().query<{ table_name: string }>(`
        SELECT c.relname AS table_name FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        ORDER BY 1`);
      expect(tables.length).toBeGreaterThan(60);
      const leaks: string[] = [];
      for (const { table_name } of tables) {
        const { rows } = await runInTenant(tenantB, () => db.query(`SELECT count(*)::int AS n FROM ${table_name} WHERE tenant_id <> $1`, [tenantB]));
        if (rows[0].n > 0) leaks.push(`${table_name}: ${rows[0].n}`);
      }
      expect(leaks).toEqual([]);
      // Tenant 1 has rows there, so the check means something.
      expect((await ownerDb().query(`SELECT count(*)::int AS n FROM branches WHERE tenant_id = 1`)).rows[0].n).toBeGreaterThan(0);
    });

    it("lets a tenant's work neither write, change nor delete another tenant's rows", async () => {
      await expect(runInTenant(tenantB, () => db.query(
        `INSERT INTO customer_groups (tenant_id, name) VALUES (1, $1)`, [`${PREFIX}foreign`],
      ))).rejects.toMatchObject({ code: '42501' });
      const updated = await runInTenant(tenantB, () => db.query(`UPDATE customers SET full_name = 'taken over' WHERE id = $1`, [customerA]));
      const deleted = await runInTenant(tenantB, () => db.query(`DELETE FROM customers WHERE id = $1`, [customerA]));
      expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
      const { rows } = await ownerDb().query(`SELECT full_name FROM customers WHERE id = $1`, [customerA]);
      expect(rows).toEqual([{ full_name: `${PREFIX}tenant 1 customer` }]);
    });

    it('shows work without a tenant nothing', async () => {
      setFallbackTenant(undefined);
      try {
        expect((await db.query(`SELECT count(*)::int AS n FROM branches`)).rows[0].n).toBe(0);
      } finally {
        setFallbackTenant(1);
      }
    });
  });

  describe('the API, for a second tenant', () => {
    it("lists none of the first tenant's customers, and does not find one by id", async () => {
      const list = await asB(api().get('/api/v1/customers?pageSize=100'));
      expect(list.status).toBe(200);
      expect(list.body.items.map((c: { id: number }) => c.id)).not.toContain(customerA);
      expect((await asB(api().get(`/api/v1/customers/${customerA}`))).status).toBe(404);
    });

    it("finds none of the first tenant's books", async () => {
      const res = await asB(api().get(`/api/v1/books?q=${encodeURIComponent(bookA.title)}`));
      expect(res.status).toBe(200);
      expect(res.body.items.map((b: { id: number }) => b.id)).not.toContain(bookA.id);
      expect((await asB(api().get(`/api/v1/books/${bookA.id}`))).status).toBe(404);
    });

    it('lists only its own branches', async () => {
      const res = await asB(api().get('/api/v1/branches?pageSize=100'));
      expect(res.body.items.map((b: { id: number }) => b.id)).toEqual([branchB]);
    });

    it("counts only its own customers in reports", async () => {
      const res = await asB(api().get('/api/v1/reports/customers'));
      expect(res.status).toBe(200);
      const { rows } = await ownerDb().query(`SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1`, [tenantB]);
      expect(res.body.summary.totalCustomers).toBe(rows[0].n);
    });

    it("takes a customer whose phone a customer of another tenant has (was: 409 duplicate)", async () => {
      const res = await asB(api().post('/api/v1/customers')).send({ fullName: `${PREFIX}tenant B customer`, phone: PHONE });
      expect(res.status).toBe(201);
    });

    it('still refuses a username another tenant uses: usernames are unique across tenants', async () => {
      const { rows: [taken] } = await ownerDb().query(`SELECT username FROM staff WHERE tenant_id = 1 ORDER BY id LIMIT 1`);
      const res = await asB(api().post('/api/v1/staff')).send({
        username: taken.username, password: NEW_PASSWORD, fullName: 'Copy', roles: [{ branchId: branchB, role: 'Sales' }],
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('DUPLICATE_USERNAME');
    });
  });

  it('retires the public branch list, which showed every branch before sign-in', async () => {
    const res = await api().get('/api/v1/branches/public');
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('DEPRECATED');
  });
});
