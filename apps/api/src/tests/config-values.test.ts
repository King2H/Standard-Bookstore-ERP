import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches, cleanBranchConfig } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

// #23 (Settings screen), owner decisions 1a and 2a:
// - the discount presets POS reads were refused as unknown keys, so they could
//   never be changed;
// - JSON settings took any value, so a mistyped discount limit was stored as
//   text and read back as 0 for every role;
// - the settings rules looked only at the first role held in the session branch.

const STAFF_PREFIX = 'cfg_val_';
const BRANCH_PREFIX = 'Config Values ';
const PRESETS = [
  'default_discount_type', 'default_discount_mode', 'default_discount_value',
  'default_discount_mode_normal', 'default_discount_value_normal',
  'default_discount_mode_merchant', 'default_discount_value_merchant',
  'default_discount_mode_special', 'default_discount_value_special',
];

describe('Settings values and who changes them', () => {
  let superAdmin: string;
  let promotedSuperAdmin: string;
  let promotedAdmin: string;
  let branchId: number;
  let saved: Array<{ key: string; value: unknown }>;
  const api = () => request(getTestApp());
  const put = (path: string, token: string, value: unknown) => api().put(path).set('Authorization', `Bearer ${token}`).send({ value });

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
    saved = (await db.query(`SELECT key, value FROM system_config WHERE key = ANY($1)`, [[...PRESETS, 'max_line_discount_pct']])).rows;

    superAdmin = (await createTestStaff({ username: `${STAFF_PREFIX}sa`, role: 'Super_Admin', branchId })).token;
    // Managers first, given a higher role in the same branch later.
    const later = async (name: string, role: string) => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role: 'Manager', branchId });
      await db.query(`INSERT INTO staff_branch_roles (staff_id, branch_id, role) VALUES ($1, $2, $3)`, [s.staffId, branchId, role]);
      return s.token;
    };
    promotedSuperAdmin = await later('to_sa', 'Super_Admin');
    promotedAdmin = await later('to_admin', 'Admin');
  });

  afterAll(async () => {
    for (const { key, value } of saved) {
      await db.query(`UPDATE system_config SET value = $2 WHERE key = $1`, [key, JSON.stringify(value)]);
    }
    await cleanBranchConfig(branchId);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  it('saves the discount presets POS uses (was: 400 unknown key)', async () => {
    for (const [key, value] of [
      ['default_discount_type', 'Merchant'], ['default_discount_mode_normal', 'Amount'], ['default_discount_value_special', 5],
    ] as const) {
      const res = await put(`/api/v1/config/system/${key}`, superAdmin, value);
      expect({ key, status: res.status }).toEqual({ key, status: 200 });
    }
  });

  it('refuses a preset outside its choices', async () => {
    for (const [key, value] of [['default_discount_type', 'Huge'], ['default_discount_mode', 'Fraction'], ['default_discount_value', -1]] as const) {
      const res = await put(`/api/v1/config/system/${key}`, superAdmin, value);
      expect({ key, status: res.status, error: res.body.error }).toEqual({ key, status: 400, error: 'VALIDATION_ERROR' });
    }
  });

  it('refuses a discount limit that is not role and percentage (was: stored as text, read as 0 for every role)', async () => {
    for (const value of ['{"Sales": 10', { Sales: 150 }, { Nobody: 5 }, [10]]) {
      const res = await put('/api/v1/config/system/max_line_discount_pct', superAdmin, value);
      expect({ value, status: res.status }).toEqual({ value, status: 400 });
    }
    const ok = await put('/api/v1/config/system/max_line_discount_pct', superAdmin, { Sales: 10, Manager: 25, Admin: 50 });
    expect(ok.status).toBe(200);
  });

  it('refuses payment methods and notification settings of the wrong shape', async () => {
    expect((await put(`/api/v1/config/branches/${branchId}/allowed_payment_methods`, superAdmin, 'cash')).status).toBe(400);
    expect((await put(`/api/v1/config/branches/${branchId}/allowed_payment_methods`, superAdmin, ['cash', 'gold'])).status).toBe(400);
    expect((await put(`/api/v1/config/branches/${branchId}/allowed_payment_methods`, superAdmin, ['cash', 'bank'])).status).toBe(200);
    expect((await put(`/api/v1/config/branches/${branchId}/notification_prefs`, superAdmin, [])).status).toBe(400);
  });

  it('counts any role held: a Manager also made Super_Admin changes system settings (was: 403)', async () => {
    const res = await put('/api/v1/config/system/default_discount_value', promotedSuperAdmin, 0);
    expect(res.status).toBe(200);
  });

  it('counts any role held: a Manager also made Admin removes a branch override (was: 403)', async () => {
    expect((await put(`/api/v1/config/branches/${branchId}/return_window_days`, promotedAdmin, 10)).status).toBe(200);
    const res = await api().delete(`/api/v1/config/branches/${branchId}/return_window_days`).set('Authorization', `Bearer ${promotedAdmin}`);
    expect(res.status).toBe(200);
  });
});
