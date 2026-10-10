/**
 * exchanges-lifecycle.test.ts
 *
 * The draft -> confirmed -> settled exchange lifecycle (initiate -> review ->
 * approve -> settle, and cancel) is retired (#21, owner decision 1a): an
 * exchange is made in one step with POST /exchanges and undone on its day
 * with POST /exchanges/{id}/void. The endpoints answer 410; exchanges made
 * through the lifecycle stay readable, with their items from exchange_items.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'exc_lc_test_';
const BRANCH_PREFIX = 'Exchange LC Test ';

async function cleanExchanges(branchId: number) {
  await db.query(`DELETE FROM exchange_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM exchanges WHERE branch_id = $1`, [branchId]);
}

describe('Exchanges — retired lifecycle', () => {
  let managerToken: string;
  let managerId: number;
  let branchId: number;
  let lifecycleExchangeId: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test) => r.set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId));

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`]);
    for (const row of oldBranches.rows) await cleanExchanges(row.id as number);
    await cleanTestBranches(BRANCH_PREFIX);

    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
    const mgr = await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId });
    managerToken = mgr.token;
    managerId = mgr.staffId;

    // An exchange made through the lifecycle before it was retired.
    const book = (await db.query(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 1`)).rows[0].id;
    lifecycleExchangeId = String((await db.query(
      `INSERT INTO exchanges (exchange_reference, branch_id, status, lifecycle_status, total_incoming_value, total_outgoing_value,
                              net_balance, settlement_type, created_by)
       VALUES ('EXC-LC-TEST-0001', $1, 'Completed', 'COMPLETED', 10, 10, 0, 'Even', $2) RETURNING id`,
      [branchId, managerId],
    )).rows[0].id);
    await db.query(
      `INSERT INTO exchange_items (exchange_id, book_id, quantity, unit_price, total_price, type, condition)
       VALUES ($1, $2, 1, 10, 10, 'returned', 'damaged'), ($1, $2, 1, 10, 10, 'new', 'resellable')`,
      [lifecycleExchangeId, book],
    );
  });

  afterAll(async () => {
    await cleanExchanges(branchId);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  it('answers 410 to initiate, review, approve, settle and cancel', async () => {
    expect((await as(api().post('/api/v1/exchanges/initiate')).send({})).status).toBe(410);
    for (const action of ['review', 'approve', 'settle', 'cancel']) {
      const res = await as(api().post(`/api/v1/exchanges/${lifecycleExchangeId}/${action}`)).send({});
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('DEPRECATED');
    }
  });

  it('still reads an exchange made through the lifecycle, with its items', async () => {
    const res = await as(api().get(`/api/v1/exchanges/${lifecycleExchangeId}`));
    expect(res.status).toBe(200);
    expect(res.body.lifecycleStatus).toBe('COMPLETED');
    expect(res.body.voidable).toBe(false);
    expect(res.body.incomingItems).toHaveLength(1);
    expect(res.body.incomingItems[0].condition).toBe('damaged');
    expect(res.body.outgoingItems).toHaveLength(1);
  });
});
