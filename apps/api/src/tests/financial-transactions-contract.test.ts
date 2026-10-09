import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { FinancialTransactionListResponseSchema } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Financial transactions after the module migration (#21): the ledger list
// follows the shared contract, and the hand-written entry endpoint is retired
// (owner decision). It booked payments, even negative ones or against another
// branch's order, without updating the order, and a missing order gave a 500.

const STAFF_PREFIX = 'ftc_test_';
const BRANCH_PREFIX = 'FT Contract ';
const KEY = 'ftc-test-';

describe('Financial transactions on the shared contracts', () => {
  let branchA: number;
  let branchB: number;
  let finance: string;
  let sales: string;
  let orderInB: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  async function cleanUp() {
    await db.query(`DELETE FROM financial_transactions WHERE idempotency_key LIKE $1`, [`${KEY}%`]);
    await db.query(`DELETE FROM orders WHERE order_number LIKE 'FTC-%'`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    const f = await createTestStaff({ username: `${STAFF_PREFIX}fin`, role: 'Finance_Officer', branchId: branchA });
    finance = f.token;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId: branchA })).token;
    const orderInA = (await db.query(
      `INSERT INTO orders (order_number, branch_id, status, created_by) VALUES ('FTC-A', $1, 'CONFIRMED', $2) RETURNING id`,
      [branchA, f.staffId],
    )).rows[0].id;
    orderInB = (await db.query(
      `INSERT INTO orders (order_number, branch_id, status, created_by) VALUES ('FTC-B', $1, 'CONFIRMED', $2) RETURNING id`,
      [branchB, f.staffId],
    )).rows[0].id;
    await db.query(
      `INSERT INTO financial_transactions (type, order_id, idempotency_key, amount, staff_id, branch_id)
       VALUES ('payment', $1, '${KEY}a', 12.50, $3, $4), ('payment', $2, '${KEY}b', 99.00, $3, $5)`,
      [orderInA, orderInB, f.staffId, branchA, branchB],
    );
  });

  afterAll(cleanUp);

  it('lists the session branch\'s ledger in the shape of the shared schema', async () => {
    const res = await as(api().get(`/api/v1/financial-transactions?pageSize=100`), finance);
    expect(res.status).toBe(200);
    expect(FinancialTransactionListResponseSchema.strict().parse(res.body)).toEqual(res.body);
    const mine = res.body.items.filter((t: { idempotencyKey: string }) => t.idempotencyKey.startsWith(KEY));
    expect(mine).toEqual([expect.objectContaining({ idempotencyKey: `${KEY}a`, amount: 12.5, branchId: branchA })]);
  });

  it('refuses to write a ledger entry by hand (was: 201, booked without touching the order)', async () => {
    const res = await as(api().post('/api/v1/financial-transactions'), sales).send({
      type: 'payment', orderId: Number(orderInB), idempotencyKey: `${KEY}c`, amount: 500,
    });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('DEPRECATED');
    const written = await db.query(`SELECT 1 FROM financial_transactions WHERE idempotency_key = $1`, [`${KEY}c`]);
    expect(written.rows).toEqual([]);
  });

  it('answers 400 VALIDATION_ERROR for a type that does not exist (was: an empty list)', async () => {
    const res = await as(api().get('/api/v1/financial-transactions?type=bonus'), finance);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
