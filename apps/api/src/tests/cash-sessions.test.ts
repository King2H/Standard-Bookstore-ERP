/**
 * cash-sessions.test.ts
 *
 * #171 (owner decisions 1a–6a, 2026-10-28, scope revised to what a shop
 * needs): the cash a staff member holds at the counter. No tills: a session
 * is one person's in one branch, opened with a float (0 when the drawer
 * starts empty). Every counter flow records its money on the open session:
 * POS sales, collections and voids, order payments and refunds, receivable
 * collections, return refunds, and exchange payments, refunds and voids. A
 * reversal goes to the session that took the money while that session is
 * open. Cash put in or taken out by hand is recorded with a type and a
 * reason, never more than the drawer holds. Closing counts the cash blind;
 * expected, counted and variance are stored, numbered Z-; beyond the
 * branch's limit the session waits for a Manager or Admin. A branch may
 * require a session for cash at the counter. Before, cash was taken with no
 * session at all, so a drawer could not be checked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';
import { handleNotification, NOTIFICATION_EVENTS } from '../workers/notificationWorker.js';
import { HANDLERS } from '../workers/outboxPoller.js';

const STAFF_PREFIX = 'cash_test_';
const BRANCH_PREFIX = 'Cash Sessions ';
const CUSTOMER_CODE = 'CASHSESS-001';

describe('Cash sessions (#171)', () => {
  let branchId: number;
  let branchB: number;
  let locationId: number;
  let customerId: number;
  let bookId: number;
  let price: number;
  const t: Record<string, string> = {};
  const id: Record<string, number> = {};
  let session: number;

  const api = () => request(getTestApp());
  const as = (token: string) => ({
    get: (path: string) => api().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => api().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => api().put(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const open = (token: string, openingFloat: number | string = 0) => as(token).post('/api/v1/cash-sessions', { openingFloat });
  const current = (token: string) => as(token).get('/api/v1/cash-sessions/current');
  const detail = (token: string, sessionId: number) => as(token).get(`/api/v1/cash-sessions/${sessionId}`);
  const move = (token: string, sessionId: number, body: object) => as(token).post(`/api/v1/cash-sessions/${sessionId}/movements`, body);
  const close = (token: string, sessionId: number, countedCash: number | string, note?: string) =>
    as(token).post(`/api/v1/cash-sessions/${sessionId}/close`, { countedCash, ...(note && { note }) });
  const review = (token: string, sessionId: number, body: object) => as(token).post(`/api/v1/cash-sessions/${sessionId}/review`, body);
  const setBranch = (key: string, value: unknown) => as(t.manager).put(`/api/v1/config/branches/${branchId}/${key}`, { value });

  const sell = (token: string, payments: object[], extra: object = {}) =>
    as(token).post('/api/v1/pos/transactions', { locationId, items: [{ bookId, quantity: 1 }], payments, ...extra });
  /** The movements recorded on a session: [kind, method, direction, amount]. */
  const movements = async (sessionId: number) =>
    (await db.query(
      `SELECT kind, method, direction, amount::text AS amount FROM cash_session_movements WHERE session_id = $1 ORDER BY id`,
      [sessionId],
    )).rows.map((r) => [r.kind, r.method, r.direction, r.amount]);
  /** Float plus cash in less cash out, from the rows themselves. */
  const drawer = async (sessionId: number) =>
    Number((await one(
      `SELECT s.opening_float + COALESCE(SUM(CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END) FILTER (WHERE m.method = 'cash'), 0) AS expected
       FROM cash_sessions s LEFT JOIN cash_session_movements m ON m.session_id = s.id WHERE s.id = $1 GROUP BY s.id`,
      [sessionId],
    )).expected);

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    const customer = `SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`;
    for (const statement of [
      `DELETE FROM cash_session_movements WHERE session_id IN (SELECT id FROM cash_sessions WHERE branch_id IN (${branches}))`,
      `DELETE FROM cash_sessions WHERE branch_id IN (${branches})`,
      `DELETE FROM notifications WHERE branch_id IN (${branches})`,
      `DELETE FROM order_refunds WHERE order_id IN (${orders})`,
      `DELETE FROM order_payments WHERE order_id IN (${orders})`,
      `DELETE FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id IN (${orders})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${orders})`,
      `DELETE FROM order_line_items WHERE order_id IN (${orders})`,
      `DELETE FROM orders WHERE id IN (${orders})`,
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM store_credit_history WHERE customer_id IN (${customer})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customer})`,
      `DELETE FROM loyalty_history WHERE customer_id IN (${customer})`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (${customer})`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => {
        // Before the migration the cash tables do not exist yet.
        if (err.code !== '42P01') throw err;
      });
    }
    // Branches first: their exchanges name the staff who voided them.
    await cleanTestBranches(BRANCH_PREFIX);
    await cleanTestStaff(STAFF_PREFIX);
    await db.query(`DELETE FROM receivables WHERE customer_id IN (${customer})`);
    await db.query(`DELETE FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    for (const [name, role, branch] of [
      ['sales', 'Sales', branchId], ['sales2', 'Sales', branchId], ['manager', 'Manager', branchId],
      ['finance', 'Finance_Officer', branchId], ['clerk', 'Stock_Clerk', branchId], ['managerB', 'Manager', branchB],
    ] as const) {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId: branch });
      t[name] = s.token;
      id[name] = s.staffId;
    }
    locationId = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Cash Counter', true) RETURNING id`, [branchId])).id;
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 AND default_price < 400 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, 500, 5, 0, 4)`, [bookId, locationId]);
    customerId = (await one(`INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Cash Customer', $1, true) RETURNING id`, [CUSTOMER_CODE])).id;
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 1000)`, [customerId]);
  });

  afterAll(cleanUp);

  describe('opening (decision 1a)', () => {
    it('has the shop settings, off and 50 by default', async () => {
      const res = await as(t.manager).get('/api/v1/config/effective?keys=require_cash_session,cash_variance_limit');
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'require_cash_session', value: false }),
        expect.objectContaining({ key: 'cash_variance_limit', value: 50 }),
      ]));
    });

    it('starts with no session, not required', async () => {
      const res = await current(t.sales);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ required: false, session: null });
    });

    it('is opened by those who take payments, with a float; not by a Stock_Clerk', async () => {
      expect((await open(t.clerk, 100)).status).toBe(403);
      expect((await open(t.sales, -5)).status).toBe(400);
      const res = await open(t.sales, '200.00');
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      session = res.body.id;
      expect(res.body).toMatchObject({
        branchId, staffId: id.sales, status: 'open', openingFloat: 200, currency: 'ETB',
        expectedCash: null, countedCash: null, variance: null, zNumber: null,
      });
      expect((await current(t.sales)).body.session).toMatchObject({ id: session, status: 'open' });
    });

    it('is one open session per person in a branch', async () => {
      const again = await open(t.sales, 0);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('CASH_SESSION_ALREADY_OPEN');
    });

    it('opens with no float, for a shop whose drawer starts empty', async () => {
      const res = await open(t.manager, 0);
      expect(res.status).toBe(201);
      id.managerSession = res.body.id;
      expect(res.body.openingFloat).toBe(0);
    });
  });

  describe('the counter records its money on the open session (decision 2a)', () => {
    let saleId: string;

    it('records a POS sale by each method taken at the counter, not store credit', async () => {
      const cash = await sell(t.sales, [{ method: 'cash', amount: price }]);
      expect(cash.status, JSON.stringify(cash.body)).toBe(201);
      saleId = cash.body.id;
      expect((await sell(t.sales, [{ method: 'mobile', reference: 'TB-CASH-1', amount: price }])).status).toBe(201);
      expect((await sell(t.sales, [{ method: 'store_credit', amount: price }], { customerId })).status).toBe(201);
      expect(await movements(session)).toEqual([
        ['pos_payment', 'cash', 'in', price.toFixed(2)],
        ['pos_payment', 'mobile', 'in', price.toFixed(2)],
      ]);
    });

    it('records a later payment on a credit sale', async () => {
      const credit = await sell(t.sales, [], { customerId, allowCredit: true, dueDate: '2099-12-31' });
      expect(credit.status).toBe(201);
      expect((await as(t.sales).post(`/api/v1/pos/transactions/${credit.body.id}/payment`, { payments: [{ method: 'cash', amount: 5 }] })).status).toBe(200);
      expect((await movements(session)).at(-1)).toEqual(['pos_payment', 'cash', 'in', '5.00']);
    });

    it("records a void on the session that took the money while it is open, whoever voids (was: nowhere)", async () => {
      expect((await as(t.manager).post(`/api/v1/pos/transactions/${saleId}/void`)).status).toBe(200);
      expect((await movements(session)).at(-1)).toEqual(['pos_void', 'cash', 'out', price.toFixed(2)]);
      expect(await movements(id.managerSession)).toEqual([]);
    });

    it('records an order paid at confirmation, a payment on a credit order, and the refunds', async () => {
      const order = async (saleType: string) =>
        (await as(t.sales).post('/api/v1/orders', { locationId, customerId, saleType, items: [{ bookId, quantity: 1 }] })).body.id;
      const cashOrder = await order('cash_sale');
      expect((await as(t.sales).post(`/api/v1/orders/${cashOrder}/confirm`, { paymentMethod: 'cash' })).status).toBe(200);
      const creditOrder = await order('credit_sale');
      expect((await as(t.sales).post(`/api/v1/orders/${creditOrder}/confirm`, { dueDate: '2099-12-31' })).status).toBe(200);
      const paid = await as(t.sales).post('/api/v1/payments', { orderId: creditOrder, amount: 7, paymentMethod: 'cash' });
      expect(paid.status).toBe(201);

      // Finance refunds from their own session.
      const financeSession = (await open(t.finance, 50)).body.id;
      expect((await as(t.finance).post(`/api/v1/payments/${paid.body.id}/refund`, { refundAmount: 2, reason: 'Overcharged' })).status).toBe(201);
      expect(await movements(financeSession)).toEqual([['order_refund', 'cash', 'out', '2.00']]);

      expect((await movements(session)).slice(-2)).toEqual([
        ['order_payment', 'cash', 'in', price.toFixed(2)],
        ['order_payment', 'cash', 'in', '7.00'],
      ]);

      // The manager cancels the paid order (#167) and hands the money back from their own drawer.
      expect((await as(t.manager).post(`/api/v1/orders/${cashOrder}/cancel`, { reason: 'Changed mind', refundTo: 'original' })).status).toBe(200);
      expect(await movements(id.managerSession)).toEqual([['order_refund', 'cash', 'out', price.toFixed(2)]]);
    });

    it('records a return refund', async () => {
      const sale = await sell(t.sales, [{ method: 'cash', amount: price }]);
      const line = (await as(t.sales).get(`/api/v1/pos/transactions/${sale.body.id}`)).body.lineItems[0].id;
      const ret = await as(t.sales).post('/api/v1/returns', { transactionId: Number(sale.body.id), lines: [{ transactionLineItemId: Number(line), quantity: 1 }] });
      expect(ret.status, JSON.stringify(ret.body)).toBe(201);
      expect((await movements(session)).slice(-2)).toEqual([
        ['pos_payment', 'cash', 'in', price.toFixed(2)],
        ['return_refund', 'cash', 'out', price.toFixed(2)],
      ]);
    });

    it('records exchange payments, cash refunds, collections and voids', async () => {
      const pays = await as(t.sales).post('/api/v1/exchanges', {
        locationId, customerId, incomingItems: [{ bookId, quantity: 1, unitPrice: 1 }], outgoingItems: [{ bookId, quantity: 1 }],
        payments: [{ method: 'cash', amount: 3 }], allowCredit: true, dueDate: '2099-12-31',
      });
      expect(pays.status, JSON.stringify(pays.body)).toBe(201);
      const refunds = await as(t.sales).post('/api/v1/exchanges', {
        locationId, incomingItems: [{ bookId, quantity: 1, unitPrice: 2 }], refundMethod: 'cash',
      });
      expect(refunds.status, JSON.stringify(refunds.body)).toBe(201);
      const receivable = await one(`SELECT id FROM receivables WHERE source_type = 'exchange_difference' AND source_entity_id = $1`, [pays.body.id]);
      expect((await as(t.sales).post(`/api/v1/receivables/${receivable.id}/collect`, { amount: 4, paymentMethod: 'cash' })).status).toBe(200);
      expect((await as(t.manager).post(`/api/v1/exchanges/${refunds.body.id}/void`, { reason: 'Wrong book' })).status).toBe(200);
      expect((await movements(session)).slice(-4)).toEqual([
        ['exchange_payment', 'cash', 'in', '3.00'],
        ['exchange_refund', 'cash', 'out', '2.00'],
        ['receivable_payment', 'cash', 'in', '4.00'],
        ['exchange_void', 'cash', 'in', '2.00'],
      ]);
    });
  });

  describe('cash put in or taken out (decision 3a)', () => {
    it('takes a type and a reason; the type fits the direction', async () => {
      expect((await move(t.sales, session, { direction: 'out', category: 'bank_drop', amount: 50 })).status).toBe(400);
      expect((await move(t.sales, session, { direction: 'out', category: 'float_top_up', amount: 50, reason: 'x' })).status).toBe(400);
      expect((await move(t.sales, session, { direction: 'in', category: 'petty_cash', amount: 50, reason: 'x' })).status).toBe(400);
      const out = await move(t.sales, session, { direction: 'out', category: 'bank_drop', amount: 50, reason: 'Deposit at CBE' });
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      expect((await move(t.sales, session, { direction: 'in', category: 'float_top_up', amount: 20, reason: 'Change from the manager' })).status).toBe(201);
      expect((await movements(session)).slice(-2)).toEqual([['pay_out', 'cash', 'out', '50.00'], ['pay_in', 'cash', 'in', '20.00']]);
    });

    it('never takes out more than the drawer holds', async () => {
      const res = await move(t.sales, session, { direction: 'out', category: 'petty_cash', amount: (await drawer(session)) + 1, reason: 'Too much' });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('CASH_SESSION_INSUFFICIENT_CASH');
    });

    it("is the session's own staff member's: not another's, not a manager's", async () => {
      expect((await move(t.sales2, session, { direction: 'out', category: 'other', amount: 1, reason: 'x' })).status).toBe(403);
      expect((await move(t.manager, session, { direction: 'out', category: 'other', amount: 1, reason: 'x' })).status).toBe(403);
    });
  });

  describe('who sees what (decisions 5a)', () => {
    it("hides what is expected from the cashier while open; a manager sees the X report", async () => {
      const own = await detail(t.sales, session);
      expect(own.status).toBe(200);
      expect(own.body).toMatchObject({ expectedCash: null, totals: null });
      expect(own.body.movements.map((m: { kind: string }) => m.kind)).toEqual(['pay_out', 'pay_in']);

      const x = await detail(t.manager, session);
      expect(x.body.expectedCash).toBeCloseTo(await drawer(session), 2);
      expect(x.body.totals).toEqual(expect.arrayContaining([
        { kind: 'pos_payment', method: 'mobile', direction: 'in', count: 1, amount: price },
        { kind: 'pay_out', method: 'cash', direction: 'out', count: 1, amount: 50 },
      ]));
      expect(x.body.movements.length).toBe((await movements(session)).length);
    });

    it('lists the branch to Manager and Finance_Officer, and only their own to a cashier', async () => {
      const all = await as(t.finance).get('/api/v1/cash-sessions');
      expect(all.status).toBe(200);
      expect(new Set(all.body.items.map((s: { staffId: number }) => s.staffId))).toEqual(new Set([id.sales, id.manager, id.finance]));
      const mine = await as(t.sales).get('/api/v1/cash-sessions');
      expect(mine.body.items.map((s: { staffId: number }) => s.staffId)).toEqual([id.sales]);
      expect((await as(t.sales).get(`/api/v1/cash-sessions?staffId=${id.manager}`)).body.items).toEqual([]);
      expect((await detail(t.sales, id.managerSession)).status).toBe(403);
      expect((await detail(t.clerk, session)).status).toBe(403);
    });

    it("is kept from another branch, as if it did not exist", async () => {
      expect((await detail(t.managerB, session)).status).toBe(404);
      expect((await as(t.managerB).get('/api/v1/cash-sessions')).body.items).toEqual([]);
    });
  });

  describe('closing (decision 4a)', () => {
    it('counts blind; within the limit it closes, numbered Z-, with expected, counted and variance', async () => {
      const expected = await drawer(session);
      const res = await close(t.sales, session, (expected - 10).toFixed(2), 'Short by a ten');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: 'closed', closedBy: id.sales, closeNote: 'Short by a ten', variance: -10 });
      expect(res.body.expectedCash).toBeCloseTo(expected, 2);
      expect(res.body.countedCash).toBeCloseTo(expected - 10, 2);
      expect(res.body.zNumber).toMatch(/^Z-\d{8}-\d{4}$/);
      expect(res.body.totals.length).toBeGreaterThan(0);
      expect((await current(t.sales)).body.session).toBeNull();
    });

    it('takes nothing more once closed; later cash goes to no session while none is required', async () => {
      expect((await move(t.sales, session, { direction: 'in', category: 'other', amount: 1, reason: 'x' })).body.error).toBe('CASH_SESSION_INVALID_STATUS');
      expect((await close(t.sales, session, 0)).body.error).toBe('CASH_SESSION_INVALID_STATUS');
      const before = (await movements(session)).length;
      expect((await sell(t.sales, [{ method: 'cash', amount: price }])).status).toBe(201);
      expect((await movements(session)).length).toBe(before);
    });

    it('waits for a Manager beyond the branch limit, who is told and accepts it with a reason', async () => {
      expect((await setBranch('cash_variance_limit', 5)).status).toBe(200);
      const next = (await open(t.sales, 100)).body.id;
      expect((await sell(t.sales, [{ method: 'cash', amount: price }])).status).toBe(201);
      const res = await close(t.sales, next, (100 + price + 10).toFixed(2));
      expect(res.body).toMatchObject({ status: 'pending_review', variance: 10 });

      const event = await one(`SELECT payload FROM outbox WHERE event_type = 'cash_session.review_needed' AND payload->>'sessionId' = $1`, [String(next)]);
      expect(event.payload).toMatchObject({ branchId, variance: 10, zNumber: res.body.zNumber });
      await handleNotification({ ...event.payload, _eventType: 'cash_session.review_needed' });
      const note = await one(`SELECT body, target_roles, entity_type FROM notifications WHERE event_type = 'cash_session.review_needed' AND entity_id = $1`, [String(next)]);
      expect(note).toMatchObject({ entity_type: 'cash_session', target_roles: ['Manager', 'Admin'] });
      expect(note.body).toContain(res.body.zNumber);
      expect(NOTIFICATION_EVENTS).toContain('cash_session.review_needed');
      expect(HANDLERS['cash_session.review_needed']).toBe(handleNotification);

      expect((await review(t.sales, next, { reason: 'Mine' })).status).toBe(403);
      expect((await review(t.manager, next, {})).status).toBe(400);
      const accepted = await review(t.manager, next, { reason: 'Customer left change' });
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ status: 'closed', reviewedBy: id.manager, reviewReason: 'Customer left change' });
      expect((await review(t.manager, next, { reason: 'Again' })).body.error).toBe('CASH_SESSION_INVALID_STATUS');
    });

    it("is closed by a Manager when the cashier forgot; not by another cashier", async () => {
      const forgotten = (await open(t.sales2, 30)).body.id;
      expect((await close(t.sales, forgotten, 30)).status).toBe(403);
      const res = await close(t.manager, forgotten, 30, 'Left without closing');
      expect(res.body).toMatchObject({ status: 'closed', closedBy: id.manager, variance: 0 });
    });

    it('is audited at each step', async () => {
      const { rows } = await db.query(
        `SELECT meta->>'action' AS action FROM audit_logs WHERE entity_type = 'cash_session' AND entity_id = $1 ORDER BY id`,
        [String(session)],
      );
      expect(rows.map((r) => r.action)).toEqual(['open', 'pay_out', 'pay_in', 'close']);
    });
  });

  describe('a branch that requires a session for cash (decision 6a)', () => {
    it('refuses cash at the counter without one, and takes other methods', async () => {
      expect((await setBranch('require_cash_session', true)).status).toBe(200);
      expect((await current(t.sales2)).body).toEqual({ required: true, session: null });
      const before = Number((await one(`SELECT count(*) FROM transactions WHERE branch_id = $1`, [branchId])).count);
      const refused = await sell(t.sales2, [{ method: 'cash', amount: price }]);
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('CASH_SESSION_REQUIRED');
      expect(Number((await one(`SELECT count(*) FROM transactions WHERE branch_id = $1`, [branchId])).count)).toBe(before);
      expect((await sell(t.sales2, [{ method: 'mobile', reference: 'TB-CASH-2', amount: price }])).status).toBe(201);
    });

    it('takes cash once a session is open', async () => {
      const opened = (await open(t.sales2, 0)).body.id;
      expect((await sell(t.sales2, [{ method: 'cash', amount: price }])).status).toBe(201);
      expect(await movements(opened)).toEqual([['pos_payment', 'cash', 'in', price.toFixed(2)]]);
    });
  });
});
