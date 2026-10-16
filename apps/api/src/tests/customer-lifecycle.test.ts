import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #23 (Customers screen), owner decisions 1a, 2a and 3a:
// - a deactivated customer could not be activated again, and nothing could
//   archive one: only /deactivate existed;
// - a manual store-credit adjustment was stored under whatever reference type
//   the client named, so a correction could read as a POS credit sale;
// - a new customer's home branch was whatever the client sent, or none.

const STAFF_PREFIX = 'custlife_test_';
const BRANCH_PREFIX = 'Cust Life ';
const NAME_PREFIX = 'Cust Life Person';

describe('Customer lifecycle, manual adjustments and home branch', () => {
  let manager: string;
  let sales: string;
  let branchId: number;
  let otherBranchId: number;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);
  const create = async (token: string, body: object) => {
    const res = await as(api().post('/api/v1/customers'), token).send(body);
    expect(res.status).toBe(201);
    return res.body as { id: number; branchId: number | null };
  };
  const action = (id: number, verb: string, token = manager) => as(api().post(`/api/v1/customers/${id}/${verb}`), token);
  const statusOf = async (id: number) => (await db.query(`SELECT status, is_active FROM customers WHERE id = $1`, [id])).rows[0];

  async function cleanUp() {
    const ids = (await db.query(`SELECT id FROM customers WHERE full_name LIKE $1`, [`${NAME_PREFIX}%`])).rows.map((r) => r.id);
    if (ids.length) {
      for (const table of ['store_credit_history', 'store_credit_accounts', 'loyalty_accounts']) {
        await db.query(`DELETE FROM ${table} WHERE customer_id = ANY($1)`, [ids]);
      }
      await db.query(`DELETE FROM audit_logs WHERE entity_type = 'customer' AND entity_id = ANY($1::text[])`, [ids.map(String)]);
      await db.query(`DELETE FROM outbox WHERE payload->>'customerId' = ANY($1::text[])`, [ids.map(String)]);
      await db.query(`DELETE FROM customers WHERE id = ANY($1)`, [ids]);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Home` })).branchId;
    otherBranchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Other` })).branchId;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
  });

  afterAll(cleanUp);

  it('activates a deactivated customer again (was: 404, no way back)', async () => {
    const { id } = await create(sales, { fullName: `${NAME_PREFIX} One` });
    expect((await action(id, 'deactivate')).status).toBe(200);
    const res = await action(id, 'activate');
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toEqual({ status: 'ACTIVE', is_active: true });
  });

  it('archives a customer and restores it, by the shared lifecycle rules (was: 404)', async () => {
    const { id } = await create(sales, { fullName: `${NAME_PREFIX} Two` });
    expect((await action(id, 'archive')).status).toBe(200);
    expect(await statusOf(id)).toEqual({ status: 'ARCHIVED', is_active: false });

    const refused = await action(id, 'activate');
    expect({ status: refused.status, error: refused.body.error }).toEqual({ status: 422, error: 'INVALID_LIFECYCLE_TRANSITION' });

    expect((await action(id, 'restore')).status).toBe(200);
    expect(await statusOf(id)).toEqual({ status: 'ACTIVE', is_active: true });
  });

  it('keeps status changes for Admins and Managers', async () => {
    const { id } = await create(sales, { fullName: `${NAME_PREFIX} Three` });
    await action(id, 'deactivate');
    for (const verb of ['activate', 'archive', 'restore']) {
      expect({ verb, status: (await action(id, verb, sales)).status }).toEqual({ verb, status: 403 });
    }
  });

  it('records a manual store-credit adjustment as manual, whatever the client names (was: stored as named)', async () => {
    const { id } = await create(sales, { fullName: `${NAME_PREFIX} Four` });
    const res = await as(api().post(`/api/v1/customers/${id}/store-credit/adjust`), manager)
      .send({ amount: 20, direction: 'credit', reason: 'Goodwill', refType: 'pos_credit_sale', refId: 'RCPT-9' });
    expect(res.status).toBe(200);
    const history = await as(api().get(`/api/v1/customers/${id}/store-credit/history`), manager);
    expect(history.body.items.map((h: { refType: string; refId: string }) => ({ refType: h.refType, refId: h.refId })))
      .toEqual([{ refType: 'manual', refId: 'RCPT-9' }]);
  });

  it('gives a new customer the session branch as home branch, never the client\'s (was: the branch sent, or none)', async () => {
    expect((await create(sales, { fullName: `${NAME_PREFIX} Five` })).branchId).toBe(branchId);
    expect((await create(sales, { fullName: `${NAME_PREFIX} Six`, branchId: otherBranchId })).branchId).toBe(branchId);
  });

  it('keeps the home branch when a customer is edited with another branch', async () => {
    const { id } = await create(sales, { fullName: `${NAME_PREFIX} Seven` });
    const res = await as(api().put(`/api/v1/customers/${id}`), sales).send({ city: 'Adama', branchId: otherBranchId });
    expect(res.status).toBe(200);
    expect(res.body.branchId).toBe(branchId);
  });
});
