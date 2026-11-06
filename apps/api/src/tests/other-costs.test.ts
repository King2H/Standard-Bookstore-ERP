// #249 (#225 B1, M7; owner decisions 2026-11-06). "Back and ready" asks for
// the binder's actual cost, kept on the job (was: nothing asked, only the
// standard cost known). The sale keeps its standard cost, so a closed day's
// profit does not move (#230, K2); actual less standard is the binding cost
// difference on the day the job is back. A closed cash session's variance is
// cash over/short on the session's day, a pending count once accepted (was:
// on the Z and day reports only). Net profit is gross profit less the binding
// cost difference plus cash over/short; the dashboard's Net Profit is it
// (was: gross profit under that name).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'othercost_';
const BRANCH_PREFIX = 'Other Costs ';
const CODE = 'OTHERCOST';

describe('Costs below gross profit (#249)', () => {
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let price: number;
  let customerId: number;
  let binding: number;
  const t: Record<string, string> = {};
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const as = (token: string) => ({
    get: (path: string) => request(getTestApp()).get(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId)),
    post: (path: string, body: object = {}) =>
      request(getTestApp()).post(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId)).send(body),
  });
  const ok = async (res: request.Response, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body; };
  const day = async (n: number) => (await one(`SELECT (CURRENT_DATE - $1::int)::text AS d`, [n])).d as string;
  const summaryOf = async (from: string, to = from) =>
    (await ok(await as(t.manager).get(`/api/v1/reports/sales?dateFrom=${from}&dateTo=${to}`))).summary;

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const txs = `SELECT id FROM transactions WHERE branch_id IN (${branches})`;
    const customers = `SELECT id FROM customers WHERE full_name LIKE '${CODE}%'`;
    for (const statement of [
      `DELETE FROM notifications WHERE branch_id IN (${branches})`,
      `DELETE FROM service_jobs WHERE branch_id IN (${branches})`,
      `DELETE FROM sale_service_lines WHERE transaction_line_item_id IN (SELECT id FROM transaction_line_items WHERE transaction_id IN (${txs}))`,
      `DELETE FROM cash_session_movements WHERE session_id IN (SELECT id FROM cash_sessions WHERE branch_id IN (${branches}))`,
      `DELETE FROM cash_sessions WHERE branch_id IN (${branches})`,
      `DELETE FROM transaction_payments WHERE transaction_id IN (${txs})`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (${txs})`,
      `DELETE FROM transactions WHERE id IN (${txs})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM service_branch_fees WHERE service_id IN (SELECT id FROM services WHERE code = '${CODE}')`,
      `DELETE FROM services WHERE code = '${CODE}'`,
      `DELETE FROM loyalty_history WHERE customer_id IN (${customers})`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (${customers})`,
      `DELETE FROM store_credit_history WHERE customer_id IN (${customers})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customers})`,
      `DELETE FROM customers WHERE id IN (${customers})`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    for (const [name, role] of [['sales', 'Sales'], ['manager', 'Manager']] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId })).token;
    }
    locationId = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Other costs shelf', true) RETURNING id`, [branchId])).id;
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 50, 4)`, [bookId, locationId]);
    customerId = (await ok(await as(t.sales).post('/api/v1/customers', { fullName: `${CODE} Almaz`, phone: '+251911249249' }), 201)).id;
    const formatId = (await one(`SELECT id FROM book_formats ORDER BY id LIMIT 1`)).id;
    binding = (await ok(await as(t.manager).post('/api/v1/services', {
      code: CODE, name: 'Cloth binding', formatId, fee: 100, standardCost: 40, discountable: false, turnaroundDays: 3,
    }), 201)).id;
  });

  afterAll(cleanUp);

  describe("the binder's actual cost (B1)", () => {
    let job: number;

    beforeAll(async () => {
      const sale = await ok(await as(t.sales).post('/api/v1/pos/transactions', {
        locationId, customerId, items: [{ bookId, quantity: 1, service: { serviceId: binding, quantity: 1 } }],
        payments: [{ method: 'mobile', amount: price + 100, reference: 'TB-B1' }],
      }), 201);
      job = sale.lineItems[0].service.job.id;
      await ok(await as(t.sales).post(`/api/v1/service-jobs/${job}/send`));
    });

    it('is asked when the job is back and ready (was: nothing asked)', async () => {
      const refused = await as(t.sales).post(`/api/v1/service-jobs/${job}/ready`);
      expect([refused.status, refused.body.error]).toEqual([400, 'VALIDATION_ERROR']);
      expect((await ok(await as(t.sales).post(`/api/v1/service-jobs/${job}/ready`, { actualCost: '55' }))).status).toBe('READY');
    });

    it('is shown on the jobs board to those who see costs only', async () => {
      const onBoard = async (token: string) =>
        (await ok(await as(token).get('/api/v1/service-jobs?status=READY'))).items.find((j: { id: number }) => j.id === job);
      expect((await onBoard(t.manager)).actualCost).toBe(55);
      expect((await onBoard(t.sales)).actualCost).toBeNull();
    });

    it('leaves the sale at its standard cost and books the difference on the day the job is back', async () => {
      const today = await day(0);
      const now = await summaryOf(today);
      expect(now.bindingCostDifference).toBe(15);
      expect(now.netProfit).toBe(Number((now.grossProfit - 15).toFixed(2)));
      // The job came back two days ago: the difference is that day's, today's sale keeps its cost.
      await db.query(`UPDATE service_jobs SET ready_at = ready_at - INTERVAL '2 days' WHERE id = $1`, [job]);
      const after = await summaryOf(today);
      expect([after.bindingCostDifference, after.costAmount, after.grossProfit]).toEqual([0, now.costAmount, now.grossProfit]);
      expect((await summaryOf(await day(2))).bindingCostDifference).toBe(15);
    });
  });

  describe('cash over/short (M7)', () => {
    it('counts a closed session\'s variance on its day, a pending count once accepted (was: in no money figure)', async () => {
      const yesterday = await day(1);
      const open = async () => (await ok(await as(t.sales).post('/api/v1/cash-sessions', { openingFloat: 100 }), 201)).id as number;
      // Short by 3 within the limit: closed at once.
      const short = await open();
      await ok(await as(t.sales).post(`/api/v1/cash-sessions/${short}/close`, { countedCash: 97 }));
      // Over by 80, beyond the limit: waits for review.
      const over = await open();
      await ok(await as(t.sales).post(`/api/v1/cash-sessions/${over}/close`, { countedCash: 180 }));
      await db.query(`UPDATE cash_sessions SET opened_at = opened_at - INTERVAL '1 day' WHERE id IN ($1, $2)`, [short, over]);

      expect((await summaryOf(yesterday)).cashOverShort).toBe(-3);
      await ok(await as(t.manager).post(`/api/v1/cash-sessions/${over}/review`, { reason: 'Counted twice, float topped up unrecorded' }));
      const s = await summaryOf(yesterday);
      expect(s.cashOverShort).toBe(77);
      expect(s.netProfit).toBe(Number((s.grossProfit - s.bindingCostDifference + 77).toFixed(2)));
    });
  });

  it("is the dashboard's Net Profit (was: gross profit under that name)", async () => {
    const today = await day(0);
    const s = await summaryOf(today);
    const period = await ok(await as(t.manager).get('/api/v1/reports/kpis/period?period=today'));
    expect([period.grossProfit, period.netProfit]).toEqual([s.grossProfit, s.netProfit]);
    const kpis = await ok(await as(t.manager).get('/api/v1/reports/kpis'));
    expect(kpis.dailyNetProfitUnified).toBe(s.netProfit);
  });
});
