import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  BranchConfigListResponseSchema,
  ConfigEntrySchema,
  CurrencyResponseSchema,
  EffectiveConfigResponseSchema,
  SystemConfigListResponseSchema,
} from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanBranchConfig, cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Behaviour the Configuration migration (#21) adds on top of config.test.ts:
// responses follow the shared contracts and requests are validated by them.

const STAFF_PREFIX = 'cfgc_test_';
const BRANCH_PREFIX = 'Config Contract ';

describe('Configuration on the shared contracts', () => {
  let superAdmin: string;
  let branchId: number;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = superAdmin) => r.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
    const sa = await createTestStaff({ username: `${STAFF_PREFIX}sa`, role: 'Super_Admin', branchId });
    // Access to all branches, so a branch that does not exist gets past the scope check (#77) to 404.
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [sa.staffId]);
    superAdmin = sa.token;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM system_config WHERE key IN ('constructor', 'toString')`);
    await cleanBranchConfig(branchId);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  it('answers in the shape of the shared schemas', async () => {
    const system = await as(api().get('/api/v1/config/system'));
    expect(SystemConfigListResponseSchema.strict().parse(system.body)).toEqual(system.body);

    const set = await as(api().put(`/api/v1/config/branches/${branchId}/return_window_days`)).send({ value: 21 });
    expect(set.status).toBe(200);
    expect(ConfigEntrySchema.strict().parse(set.body)).toEqual(set.body);

    const branch = await as(api().get(`/api/v1/config/branches/${branchId}`));
    expect(BranchConfigListResponseSchema.strict().parse(branch.body)).toEqual(branch.body);
    expect(branch.body.items).toContainEqual(expect.objectContaining({ key: 'return_window_days', value: 21, source: 'branch' }));

    const currency = await as(api().get('/api/v1/config/currency'));
    expect(CurrencyResponseSchema.strict().parse(currency.body)).toEqual(currency.body);
  });

  it('accepts ?keys= as a list or repeated, for the session branch', async () => {
    const res = await as(api().get('/api/v1/config/effective?keys=return_window_days&keys=allow_negative_stock'));
    expect(res.status).toBe(200);
    expect(EffectiveConfigResponseSchema.parse(res.body)).toEqual(res.body);
    expect(res.body.items).toEqual([
      { key: 'return_window_days', value: 21, source: 'branch' },
      { key: 'allow_negative_stock', value: expect.any(Boolean), source: 'system' },
    ]);
  });

  it('refuses a key every object inherits, such as "constructor" (was: saved as a new setting)', async () => {
    for (const key of ['constructor', 'toString']) {
      const res = await as(api().put(`/api/v1/config/system/${key}`)).send({ value: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    }
    const saved = await db.query(`SELECT key FROM system_config WHERE key IN ('constructor', 'toString')`);
    expect(saved.rows).toEqual([]);
  });

  it('answers 400 VALIDATION_ERROR for a branch id that is not a number (was: 500)', async () => {
    const res = await as(api().get('/api/v1/config/branches/abc'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('answers 404 for an override on a branch that does not exist', async () => {
    const res = await as(api().put('/api/v1/config/branches/999999/return_window_days')).send({ value: 7 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
