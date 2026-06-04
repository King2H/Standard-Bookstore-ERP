import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches, cleanBranchConfig } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

describe('Config — System', () => {
  let superAdminToken: string;
  let adminToken: string;
  let branchId: number;

  beforeAll(async () => {
    await cleanTestStaff('cfg_sys_');
    await cleanTestBranches('Config Sys ');
    const branch = await createTestBranch({ name: 'Config Sys Branch' });
    branchId = branch.branchId;

    const sa = await createTestStaff({ username: 'cfg_sys_superadmin', role: 'Super_Admin', branchId });
    superAdminToken = sa.token;

    const adm = await createTestStaff({ username: 'cfg_sys_admin', role: 'Admin', branchId });
    adminToken = adm.token;
  });

  afterAll(async () => {
    // Restore any system_config values changed by tests
    await db.query(`UPDATE system_config SET value = '0.10' WHERE key = 'tax_rate'`);
    await cleanTestStaff('cfg_sys_');
    await cleanTestBranches('Config Sys ');
  });

  it('GET /api/config/system returns all 21 keys', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get('/api/config/system')
      .set('Authorization', `Bearer ${superAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(21);
    const keys = res.body.items.map((r: { key: string }) => r.key);
    expect(keys).toContain('base_currency');
    expect(keys).toContain('tax_rate');
    expect(keys).toContain('allow_negative_stock');
  });

  it('Admin can read system config', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get('/api/config/system')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('Super_Admin can update system config', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put('/api/config/system/tax_rate')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ value: 0.15 });

    expect(res.status).toBe(200);
    expect(res.body.key).toBe('tax_rate');
    expect(res.body.value).toBe(0.15);

    const audit = await db.query(
      `SELECT * FROM audit_logs WHERE entity_type = 'system_config' AND entity_id = 'tax_rate' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].action).toBe('UPDATE');
  });

  it('Admin cannot update system config (403)', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put('/api/config/system/tax_rate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 0.20 });
    expect(res.status).toBe(403);
  });

  it('Unknown config key returns 400', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put('/api/config/system/nonexistent_key')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ value: 'test' });
    expect(res.status).toBe(400);
  });

  it('Wrong value type returns 400', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put('/api/config/system/tax_rate')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ value: 'not-a-number' });
    expect(res.status).toBe(400);
  });
});

describe('Config — Branch', () => {
  let superAdminToken: string;
  let adminToken: string;
  let managerToken: string;
  let salesToken: string;
  let branchId: number;

  beforeAll(async () => {
    await cleanTestStaff('cfg_br_');
    await cleanTestBranches('Config Br ');
    const branch = await createTestBranch({ name: 'Config Br Branch' });
    branchId = branch.branchId;

    const sa = await createTestStaff({ username: 'cfg_br_sa', role: 'Super_Admin', branchId });
    superAdminToken = sa.token;

    const adm = await createTestStaff({ username: 'cfg_br_admin', role: 'Admin', branchId });
    adminToken = adm.token;

    const mgr = await createTestStaff({ username: 'cfg_br_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;

    const sales = await createTestStaff({ username: 'cfg_br_sales', role: 'Sales', branchId });
    salesToken = sales.token;
  });

  afterAll(async () => {
    await cleanBranchConfig(branchId);
    await cleanTestStaff('cfg_br_');
    await cleanTestBranches('Config Br ');
  });

  it('GET /api/config/branches/:id returns merged effective config with source labels', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get(`/api/config/branches/${branchId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(21);
    const sources = res.body.items.map((r: { source: string }) => r.source);
    expect(sources.every((s: string) => s === 'system')).toBe(true);
  });

  it('GET /api/config/effective returns requested settings with source metadata', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get(`/api/config/effective?keys=base_currency,tax_rate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'base_currency', source: expect.any(String) }),
        expect.objectContaining({ key: 'tax_rate', source: expect.any(String) }),
      ]),
    );
  });

  it('GET /api/config/effective returns null for missing config keys instead of 404', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get(`/api/config/effective?keys=default_discount_type,missing_key`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'default_discount_type', source: expect.any(String) }),
        expect.objectContaining({ key: 'missing_key', value: null, source: 'system' }),
      ]),
    );
  });

  it('Admin can set a branch config override', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put(`/api/config/branches/${branchId}/return_window_days`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 14 });

    expect(res.status).toBe(200);
    expect(res.body.key).toBe('return_window_days');
    expect(res.body.value).toBe(14);
  });

  it('Branch override takes precedence over system default', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get(`/api/config/branches/${branchId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const row = res.body.items.find((r: { key: string }) => r.key === 'return_window_days');
    expect(row.value).toBe(14);
    expect(row.source).toBe('branch');
  });

  it('Manager can set a branch config override', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put(`/api/config/branches/${branchId}/min_deposit_pct`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ value: 30 });
    expect(res.status).toBe(200);
  });

  it('Sales role cannot set branch config (403)', async () => {
    const app = getTestApp();
    const res = await request(app)
      .put(`/api/config/branches/${branchId}/return_window_days`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ value: 7 });
    expect(res.status).toBe(403);
  });

  it('Admin can delete branch override; system default restored', async () => {
    const app = getTestApp();
    const del = await request(app)
      .delete(`/api/config/branches/${branchId}/return_window_days`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);

    const get = await request(app)
      .get(`/api/config/branches/${branchId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const row = get.body.items.find((r: { key: string }) => r.key === 'return_window_days');
    expect(row.source).toBe('system');
  });

  it('All config writes produce audit log entries', async () => {
    const audit = await db.query(
      `SELECT * FROM audit_logs WHERE entity_type IN ('system_config','branch_config') ORDER BY id DESC LIMIT 5`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });
});
