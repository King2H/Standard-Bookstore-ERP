import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  CustomerGroupListResponseSchema,
  CustomerListResponseSchema,
  CustomerSchema,
  LoyaltyHistoryResponseSchema,
  StoreCreditHistoryResponseSchema,
} from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Behaviour the Customers migration (#21) adds on top of customer.test.ts:
// responses follow the shared contracts; manual loyalty and store-credit
// changes are back-office corrections (positive, with a reason, audited,
// Admin/Manager/Finance_Officer); an edited phone shows its new value.

const STAFF_PREFIX = 'custc_test_';
const BRANCH_PREFIX = 'Cust Contract ';
const NAME = 'Cust Contract Person';

describe('Customers on the shared contracts', () => {
  let manager: string;
  let sales: string;
  let customerId: number;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);
  const points = async () =>
    Number((await db.query(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1`, [customerId])).rows[0].points_balance);
  const credit = async () =>
    (await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId])).rows[0].balance;
  const audits = async (action: string) =>
    (await db.query(
      `SELECT meta FROM audit_logs WHERE entity_type = 'customer' AND entity_id = $1 AND action = $2 ORDER BY id`,
      [String(customerId), action],
    )).rows.map((r) => r.meta);

  async function cleanUp() {
    const ids = (await db.query(`SELECT id FROM customers WHERE full_name = $1`, [NAME])).rows.map((r) => r.id);
    if (ids.length) {
      for (const table of ['store_credit_history', 'store_credit_accounts', 'loyalty_history', 'loyalty_accounts']) {
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
    const branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    const created = await as(api().post('/api/v1/customers'), sales).send({ fullName: NAME, phone: '0911222333' });
    expect(created.status).toBe(201);
    customerId = created.body.id;
    await db.query(`UPDATE loyalty_accounts SET points_balance = 100 WHERE customer_id = $1`, [customerId]);
  });

  afterAll(cleanUp);

  it('answers in the shape of the shared schemas', async () => {
    const one = await as(api().get(`/api/v1/customers/${customerId}`), sales);
    expect(CustomerSchema.strict().parse(one.body)).toEqual(one.body);
    const list = await as(api().get(`/api/v1/customers?q=${encodeURIComponent(NAME)}`), sales);
    expect(CustomerListResponseSchema.strict().parse(list.body)).toEqual(list.body);
    const groups = await as(api().get('/api/v1/customer-groups'), sales);
    expect(CustomerGroupListResponseSchema.strict().parse(groups.body)).toEqual(groups.body);
    const lh = await as(api().get(`/api/v1/customers/${customerId}/loyalty/history`), sales);
    expect(LoyaltyHistoryResponseSchema.strict().parse(lh.body)).toEqual(lh.body);
    const sh = await as(api().get(`/api/v1/customers/${customerId}/store-credit/history`), sales);
    expect(StoreCreditHistoryResponseSchema.strict().parse(sh.body)).toEqual(sh.body);
  });

  it('refuses negative points, so nobody can add points by "redeeming" (was: 200, +500 points)', async () => {
    const res = await as(api().post(`/api/v1/customers/${customerId}/loyalty/redeem`), manager).send({ points: -500, reason: 'x' });
    expect(res.status).toBe(400);
    expect(await points()).toBe(100);
  });

  it('lets only Admin, Manager and Finance_Officer redeem by hand, with a reason (was: Sales, no reason)', async () => {
    expect((await as(api().post(`/api/v1/customers/${customerId}/loyalty/redeem`), sales).send({ points: 10, reason: 'x' })).status).toBe(403);
    expect((await as(api().post(`/api/v1/customers/${customerId}/loyalty/redeem`), manager).send({ points: 10 })).status).toBe(400);

    const ok = await as(api().post(`/api/v1/customers/${customerId}/loyalty/redeem`), manager).send({ points: 10, reason: 'Duplicate accrual' });
    expect(ok.status).toBe(200);
    expect(await points()).toBe(90);
    expect(await audits('REDEEM_POINTS')).toEqual([expect.objectContaining({ points: 10, reason: 'Duplicate accrual' })]);
  });

  it('answers 400 or 404 instead of 500 for a bad store-credit adjustment', async () => {
    const adjust = (id: number, body: object) => as(api().post(`/api/v1/customers/${id}/store-credit/adjust`), manager).send(body);
    expect((await adjust(customerId, { amount: -250, direction: 'credit', reason: 'x' })).status).toBe(400);
    expect((await adjust(customerId, { direction: 'credit', reason: 'x' })).status).toBe(400);
    expect((await adjust(customerId, { amount: 10, direction: 'sideways', reason: 'x' })).status).toBe(400);
    expect((await adjust(99999999, { amount: 10, direction: 'credit', reason: 'x' })).status).toBe(404);
    expect(await credit()).toBe('0.00');
  });

  it('audits a store-credit adjustment with its reason (was: no trace)', async () => {
    const res = await as(api().post(`/api/v1/customers/${customerId}/store-credit/adjust`), manager)
      .send({ amount: '25.50', direction: 'credit', reason: 'Goodwill for late delivery', refType: 'manual' });
    expect(res.status).toBe(200);
    expect(await credit()).toBe('25.50');
    expect(await audits('ADJUST_STORE_CREDIT')).toEqual([
      expect.objectContaining({ amount: '25.50', direction: 'credit', reason: 'Goodwill for late delivery' }),
    ]);
  });

  it('shows an edited phone number, and finds the customer by it (was: the old number kept showing)', async () => {
    const res = await as(api().put(`/api/v1/customers/${customerId}`), sales).send({ phone: '0911222444' });
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('0911222444');
    expect((await as(api().get(`/api/v1/customers/${customerId}`), sales)).body.phone).toBe('0911222444');
    const found = await as(api().get('/api/v1/customers?q=0911222444'), sales);
    expect(found.body.items.map((c: { id: number }) => c.id)).toEqual([customerId]);
    expect(JSON.stringify(await audits('UPDATE'))).not.toContain('0911222444');
  });
});
