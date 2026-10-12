import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { setFallbackTenant } from '../db/tenantContext.js';
import { operations, type ApiOperation } from '../openapi/operations.js';

// #13, part 4 (owner decision b): database work outside a tenant gets no
// connection, unless it says why it needs none. The tenant scope travels with
// the connection instead of every repository's parameters, so this sweep is
// what keeps it honest: every documented endpoint runs with no tenant
// fallback, and none may reach the database outside a tenant (it would answer
// 500). Without a token, sign-in and the health check are the only ones that
// may touch the database at all.

const PREFIX = 'tenant_sweep_test_';
const BRANCH = 'Tenant Sweep Test ';

const path = (op: ApiOperation) => `/api/v1${op.path.replace(/\{[^}]+\}/g, '1')}`;

function call(op: ApiOperation, token?: string) {
  const req = request(getTestApp())[op.method](path(op));
  if (token) req.set('Authorization', `Bearer ${token}`);
  return op.method === 'get' ? req : req.send({});
}

describe('Database work outside a tenant', () => {
  let token: string;

  beforeAll(async () => {
    await cleanTestStaff(PREFIX);
    await cleanTestBranches(BRANCH);
    const branchId = (await createTestBranch({ name: `${BRANCH}A` })).branchId;
    token = (await createTestStaff({ username: `${PREFIX}admin`, role: 'Admin', branchId })).token;
    setFallbackTenant(undefined);
  });

  afterAll(async () => {
    setFallbackTenant(1);
    await cleanTestStaff(PREFIX);
    await cleanTestBranches(BRANCH);
  });

  it('is reached by no endpoint called without a token', async () => {
    const failures: string[] = [];
    for (const op of operations) {
      const res = await call(op);
      if (res.status >= 500) failures.push(`${op.method.toUpperCase()} ${op.path}: ${res.status} ${res.body?.message ?? ''}`);
    }
    expect(failures).toEqual([]);
  });

  it('is reached by no read a signed-in account makes', async () => {
    const failures: string[] = [];
    for (const op of operations.filter((o) => o.method === 'get')) {
      const res = await call(op, token);
      if (res.status >= 500) failures.push(`GET ${op.path}: ${res.status} ${res.body?.message ?? ''}`);
    }
    expect(failures).toEqual([]);
  });
});
