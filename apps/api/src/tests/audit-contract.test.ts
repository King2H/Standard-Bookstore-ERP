import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AuditLogListResponseSchema } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Behaviour the Audit migration (#21) adds: responses follow the shared
// contracts, and the audit log is branch-scoped like the other branch-owned
// reads (#12): an Admin of one branch saw every branch's entries and the
// system-wide ones.

const STAFF_PREFIX = 'audc_test_';
const BRANCH_PREFIX = 'Audit Contract ';
const ENTITY = 'audit_contract_test';

describe('Audit log on the shared contracts', () => {
  let branchA: number;
  let branchB: number;
  let adminOfA: string;
  let headOffice: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);
  const entityIds = (res: request.Response) =>
    res.body.items.map((e: { entityId: string }) => e.entityId).sort();

  async function cleanUp() {
    await db.query(`DELETE FROM audit_logs WHERE entity_type = $1`, [ENTITY]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    adminOfA = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId: branchA })).token;
    const ho = await createTestStaff({ username: `${STAFF_PREFIX}ho`, role: 'Admin', branchId: branchA });
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [ho.staffId]);
    headOffice = ho.token;
    await db.query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, branch_id) VALUES ('UPDATE', $1, 'in-A', $2), ('UPDATE', $1, 'in-B', $3), ('UPDATE', $1, 'system', NULL)`,
      [ENTITY, branchA, branchB],
    );
  });

  afterAll(cleanUp);

  it('answers in the shape of the shared schema', async () => {
    const res = await as(api().get(`/api/v1/audit-logs?entityType=${ENTITY}`), headOffice);
    expect(res.status).toBe(200);
    expect(AuditLogListResponseSchema.strict().parse(res.body)).toEqual(res.body);
  });

  it('shows an Admin of one branch only that branch\'s entries (was: every branch and the system-wide ones)', async () => {
    const res = await as(api().get(`/api/v1/audit-logs?entityType=${ENTITY}`), adminOfA);
    expect(entityIds(res)).toEqual(['in-A']);
  });

  it('refuses another branch to an Admin of one branch', async () => {
    const res = await as(api().get(`/api/v1/audit-logs?entityType=${ENTITY}&branchId=${branchB}`), adminOfA);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('BRANCH_ACCESS_DENIED');
  });

  it('shows staff with access to all branches everything, or the branch they ask for', async () => {
    expect(entityIds(await as(api().get(`/api/v1/audit-logs?entityType=${ENTITY}`), headOffice))).toEqual(['in-A', 'in-B', 'system']);
    expect(entityIds(await as(api().get(`/api/v1/audit-logs?entityType=${ENTITY}&branchId=${branchB}`), headOffice))).toEqual(['in-B']);
  });

  it('answers 400 VALIDATION_ERROR for paging that is not a number (was: 500)', async () => {
    const res = await as(api().get('/api/v1/audit-logs?page=abc'), adminOfA);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
