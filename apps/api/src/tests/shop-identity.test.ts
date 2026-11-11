// #228 (#225 P1, K3; owner decisions 1a–4a, 2026-11-04): the shop's name,
// motto and TIN are shop-wide settings, changed by Super_Admin only and read
// by every signed-in staff member with their session branch's name, address
// and phone, for receipts, slips and the welcome banner. Existing installs
// start blank (4a).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const KEYS = ['shop_name', 'shop_motto', 'shop_tin'];

describe('Shop identity (#228)', () => {
  let superAdmin: string;
  let admin: string;
  let manager: string;
  let sales: string;
  let branchId: number;

  const put = (token: string, key: string, value: unknown) =>
    request(getTestApp()).put(`/api/v1/config/system/${key}`).set('Authorization', `Bearer ${token}`).send({ value });
  const shop = (token: string) => request(getTestApp()).get('/api/v1/config/shop').set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    await cleanTestStaff('shop_id_');
    await cleanTestBranches('Shop Id ');
    branchId = (await createTestBranch({ name: 'Shop Id Branch' })).branchId;
    superAdmin = (await createTestStaff({ username: 'shop_id_sa', role: 'Super_Admin', branchId })).token;
    admin = (await createTestStaff({ username: 'shop_id_admin', role: 'Admin', branchId })).token;
    manager = (await createTestStaff({ username: 'shop_id_mgr', role: 'Manager', branchId })).token;
    sales = (await createTestStaff({ username: 'shop_id_sales', role: 'Sales', branchId })).token;
  });

  afterAll(async () => {
    await db.query(`UPDATE system_config SET value = '""'::jsonb WHERE key = ANY($1)`, [KEYS]);
    await cleanTestStaff('shop_id_');
    await cleanTestBranches('Shop Id ');
  });

  it('starts blank on an existing install, listed with the settings (4a)', async () => {
    const rows = (await db.query(`SELECT key, value FROM system_config WHERE key = ANY($1) ORDER BY key`, [KEYS])).rows;
    expect(rows).toEqual([{ key: 'shop_motto', value: '' }, { key: 'shop_name', value: '' }, { key: 'shop_tin', value: '' }]);
  });

  it("gives any signed-in staff member the shop and their session branch's name, address and phone (1a)", async () => {
    const res = await shop(sales);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: '', motto: '', tin: '', taxName: 'VAT',
      branch: { id: branchId, name: 'Shop Id Branch', address: '123 Test Street', phone: '555-0000' },
    });
  });

  it('is changed by Super_Admin only, audited, and read back by everyone (1a)', async () => {
    expect((await put(admin, 'shop_name', 'Kuraz Books')).status).toBe(403);
    expect((await put(superAdmin, 'shop_name', 'Kuraz Books')).status).toBe(200);
    expect((await put(superAdmin, 'shop_motto', 'Read more')).status).toBe(200);
    expect((await put(superAdmin, 'shop_tin', '0012345678')).status).toBe(200);
    const res = await shop(sales);
    expect(res.body).toMatchObject({ name: 'Kuraz Books', motto: 'Read more', tin: '0012345678' });
    const audit = await db.query(`SELECT 1 FROM audit_logs WHERE entity_type = 'system_config' AND entity_id = 'shop_name'`);
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('holds for every branch: a branch cannot override it (1a)', async () => {
    const res = await request(getTestApp())
      .put(`/api/v1/config/branches/${branchId}/shop_name`)
      .set('Authorization', `Bearer ${manager}`)
      .send({ value: 'Another Shop' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('holds for every branch');
  });

  it('takes a TIN of 10 digits or nothing, and a name of at most 120 characters', async () => {
    expect((await put(superAdmin, 'shop_tin', '12345')).status).toBe(400);
    expect((await put(superAdmin, 'shop_tin', '')).status).toBe(200);
    expect((await put(superAdmin, 'shop_name', 'x'.repeat(121))).status).toBe(400);
    expect((await put(superAdmin, 'shop_name', 42)).status).toBe(400);
  });

  it('is refused without a sign-in', async () => {
    expect((await request(getTestApp()).get('/api/v1/config/shop')).status).toBe(401);
  });
});
