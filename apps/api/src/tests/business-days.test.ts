/**
 * business-days.test.ts
 *
 * #175 (owner decisions 1a–6a, 2026-10-31): closing a branch's day and the
 * shop's month, in the shop's local time zone.
 *
 * 1a: days are the shop's local days, from its business_timezone setting
 *     (Africa/Addis_Ababa by default); every database connection works in it.
 * 2a: a Manager, Admin or Finance_Officer closes a branch's day once every
 *     cash session of it is closed: a day report numbered DAY- is kept, and
 *     nothing more can be recorded in that branch on that day.
 * 3a: what would change a closed day's figures in place is refused (voiding
 *     a sale or an exchange, reversing a supplier payment); corrections are
 *     new documents on an open day.
 * 4a: a Finance_Officer or Admin closes a month for the whole shop once it
 *     has ended and every branch has closed each day it worked in it.
 * 5a: only an Admin reopens, with a reason; it is audited and Super_Admin
 *     and Finance_Officer are told. A day of a closed month reopens only
 *     after the month does.
 * Before, there was no close at all: any day's figures could change at any time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';
import { handleNotification, NOTIFICATION_EVENTS } from '../workers/notificationWorker.js';
import { HANDLERS } from '../workers/outboxPoller.js';

const STAFF_PREFIX = 'bday_test_';
const BRANCH_PREFIX = 'Business Days ';
const SUPPLIER = 'Business Days Supplier';
const ZONE = 'Africa/Addis_Ababa';
/** A past month no other test works in. */
const MONTH = '2001-02';
const PAST_DAY = '2001-02-10';

const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());

describe('Day and month close (#175)', () => {
  let branchA: number;
  let branchB: number;
  let branchC: number;
  const location: Record<string, number> = {};
  let bookId: number;
  let price: number;
  const t: Record<string, string> = {};
  const id: Record<string, number> = {};
  let previousZone: unknown;

  const api = () => request(getTestApp());
  const as = (token: string) => ({
    get: (path: string) => api().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => api().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => api().put(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const sell = (token: string, loc: number, amount = price) =>
    as(token).post('/api/v1/pos/transactions', { locationId: loc, items: [{ bookId, quantity: 1 }], payments: [{ method: 'cash', amount }] });
  const preview = (token: string, day: string) => as(token).get(`/api/v1/business-days/preview?day=${day}`);
  const closeDay = (token: string, day: string) => as(token).post('/api/v1/business-days/close', { day });
  const reopenDay = (token: string, dayId: number, reason?: string) => as(token).post(`/api/v1/business-days/${dayId}/reopen`, reason === undefined ? {} : { reason });
  const monthPreview = (token: string, month: string) => as(token).get(`/api/v1/business-months/preview?month=${month}`);
  const closeMonth = (token: string, month: string) => as(token).post('/api/v1/business-months/close', { month });
  const reopenMonth = (token: string, monthId: number, reason?: string) => as(token).post(`/api/v1/business-months/${monthId}/reopen`, reason === undefined ? {} : { reason });
  const setZone = (value: unknown) => as(t.superAdmin).put('/api/v1/config/system/business_timezone', { value });

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const pos = `SELECT id FROM purchase_orders WHERE supplier_id IN (SELECT id FROM suppliers WHERE name = '${SUPPLIER}')`;
    for (const statement of [
      `DELETE FROM business_days WHERE branch_id IN (${branches})`,
      `DELETE FROM business_months WHERE month = '${MONTH}-01'`,
      `DELETE FROM cash_session_movements WHERE session_id IN (SELECT id FROM cash_sessions WHERE branch_id IN (${branches}))`,
      `DELETE FROM cash_sessions WHERE branch_id IN (${branches})`,
      `DELETE FROM notifications WHERE event_type IN ('business_day.reopened', 'business_month.reopened')`,
      `DELETE FROM supplier_payments WHERE po_id IN (${pos})`,
      `DELETE FROM po_line_items WHERE po_id IN (${pos})`,
      `DELETE FROM purchase_orders WHERE id IN (${pos})`,
      `DELETE FROM suppliers WHERE name = '${SUPPLIER}'`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => {
        // Before the migration the close tables do not exist yet.
        if (err.code !== '42P01') throw err;
      });
    }
    await cleanTestBranches(BRANCH_PREFIX);
    await cleanTestStaff(STAFF_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    branchC = (await createTestBranch({ name: `${BRANCH_PREFIX}C` })).branchId;
    for (const [name, role, branch] of [
      ['sales', 'Sales', branchA], ['manager', 'Manager', branchA], ['clerk', 'Stock_Clerk', branchA],
      ['finance', 'Finance_Officer', branchA], ['admin', 'Admin', branchA], ['superAdmin', 'Super_Admin', branchA],
      ['managerB', 'Manager', branchB], ['managerC', 'Manager', branchC], ['financeC', 'Finance_Officer', branchC],
      ['adminC', 'Admin', branchC], ['purchasorC', 'Purchasor', branchC],
    ] as const) {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId: branch });
      t[name] = s.token;
      id[name] = s.staffId;
    }
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 AND default_price < 400 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    for (const [key, branch] of [['A', branchA], ['B', branchB], ['C', branchC]] as const) {
      location[key] = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, true) RETURNING id`, [branch, `Day Close ${key}`])).id;
      await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, 100, 5, 0, 4)`, [bookId, location[key]]);
    }
    previousZone = (await one(`SELECT value FROM system_config WHERE key = 'business_timezone'`))?.value;
  });

  afterAll(async () => {
    await cleanUp();
    if (previousZone !== undefined) {
      await db.query(`UPDATE system_config SET value = $1 WHERE key = 'business_timezone'`, [JSON.stringify(previousZone)]);
    }
  });

  describe('the shop\'s time zone (decision 1a)', () => {
    it('is a shop-wide setting, checked against the zones PostgreSQL knows', async () => {
      const bad = await setZone('Mars/Olympus_Mons');
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('VALIDATION_ERROR');
      expect((await setZone(42)).status).toBe(400);
      const ok = await setZone(ZONE);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const branchOverride = await as(t.admin).put(`/api/v1/config/branches/${branchA}/business_timezone`, { value: 'UTC' });
      expect(branchOverride.status).toBe(400);
    });

    it('is the time zone of every connection the shop works on (was: UTC)', async () => {
      expect((await one('SHOW TimeZone')).TimeZone).toBe(ZONE);
      expect((await one(`SELECT CURRENT_DATE::text AS today`)).today).toBe(localToday());
    });
  });

  describe('closing a branch\'s day (decision 2a)', () => {
    let sessionId: number;
    let dayId: number;

    it('is for a Manager, Admin or Finance_Officer', async () => {
      for (const who of ['sales', 'clerk', 'superAdmin']) {
        expect((await closeDay(t[who], localToday())).status, who).toBe(403);
      }
      expect((await preview(t.sales, localToday())).status).toBe(403);
    });

    it('waits for every cash session of the day to be closed', async () => {
      const opened = await as(t.sales).post('/api/v1/cash-sessions', { openingFloat: 0 });
      expect(opened.status).toBe(201);
      sessionId = opened.body.id;
      expect((await sell(t.sales, location.A)).status).toBe(201);

      const before = await preview(t.manager, localToday());
      expect(before.status, JSON.stringify(before.body)).toBe(200);
      expect(before.body).toMatchObject({ branchId: branchA, day: localToday(), status: 'open', businessDayId: null, monthClosed: false });
      expect(before.body.openCashSessions).toEqual([expect.objectContaining({ id: sessionId, status: 'open' })]);

      const refused = await closeDay(t.manager, localToday());
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('CASH_SESSIONS_OPEN');
      expect((await as(t.sales).post(`/api/v1/cash-sessions/${sessionId}/close`, { countedCash: price })).body.status).toBe('closed');
    });

    it('refuses a day that has not begun', async () => {
      const res = await closeDay(t.manager, '2999-01-01');
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('DAY_IN_FUTURE');
    });

    it('keeps the day report, numbered DAY-, and audits it', async () => {
      const res = await closeDay(t.manager, localToday());
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      dayId = res.body.id;
      expect(res.body).toMatchObject({
        branchId: branchA, day: localToday(), status: 'closed', closedBy: id.manager, reopenedAt: null,
        dayNumber: expect.stringMatching(/^DAY-\d{8}-\d{4}$/),
      });
      expect(res.body.report.sales.pos).toEqual({ count: 1, total: price });
      expect(res.body.report.money.byMethod).toEqual([{ method: 'cash', in: price, out: 0 }]);
      expect(res.body.report.money).toMatchObject({ totalIn: price, totalOut: 0 });
      expect(res.body.report.stock).toEqual([{ reason: 'sale', in: 0, out: 1 }]);
      expect(res.body.report.cash).toEqual({
        sessions: [expect.objectContaining({ id: sessionId, expected: price, counted: price, variance: 0 })],
        totalVariance: 0,
      });
      const audit = await one(`SELECT action, meta FROM audit_logs WHERE entity_type = 'business_day' AND entity_id = $1`, [String(dayId)]);
      expect(audit).toMatchObject({ action: 'CREATE', meta: expect.objectContaining({ action: 'close', dayNumber: res.body.dayNumber }) });
    });

    it('is closed once', async () => {
      const again = await closeDay(t.finance, localToday());
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('DAY_ALREADY_CLOSED');
    });

    it('takes nothing more in the branch that day (was: anything, any time)', async () => {
      const sale = await sell(t.sales, location.A);
      expect(sale.status).toBe(409);
      expect(sale.body.error).toBe('DAY_CLOSED');
      const session = await as(t.sales).post('/api/v1/cash-sessions', { openingFloat: 0 });
      expect(session.status).toBe(409);
      expect(session.body.error).toBe('DAY_CLOSED');
      expect(Number((await one(`SELECT count(*) FROM transactions WHERE branch_id = $1`, [branchA])).count)).toBe(1);
    });

    it('keeps the day\'s sales as they were: a same-day void is refused (decision 3a)', async () => {
      const sale = await one(`SELECT id FROM transactions WHERE branch_id = $1`, [branchA]);
      const voided = await as(t.manager).post(`/api/v1/pos/transactions/${sale.id}/void`);
      expect(voided.status).toBe(409);
      expect(voided.body.error).toBe('DAY_CLOSED');
      expect((await one(`SELECT status FROM transactions WHERE id = $1`, [sale.id])).status).toBe('completed');
    });

    it('leaves other branches open', async () => {
      expect((await sell(t.managerB, location.B)).status).toBe(201);
    });

    it('is listed and shown in its branch only', async () => {
      const list = await as(t.manager).get(`/api/v1/business-days?month=${localToday().slice(0, 7)}`);
      expect(list.status).toBe(200);
      expect(list.body.items).toEqual([expect.objectContaining({ id: dayId, branchId: branchA, status: 'closed' })]);
      expect((await as(t.manager).get(`/api/v1/business-days/${dayId}`)).body.report.sales.pos.count).toBe(1);
      expect((await as(t.managerB).get(`/api/v1/business-days/${dayId}`)).status).toBe(404);
      expect((await as(t.managerB).get(`/api/v1/business-days?month=${localToday().slice(0, 7)}`)).body.items).toEqual([]);
      expect((await preview(t.manager, localToday())).body).toMatchObject({ status: 'closed', businessDayId: dayId });
    });

    it('is reopened by an Admin only, with a reason; the branch can work again', async () => {
      expect((await reopenDay(t.manager, dayId, 'Late sale')).status).toBe(403);
      expect((await reopenDay(t.finance, dayId, 'Late sale')).status).toBe(403);
      expect((await reopenDay(t.admin, dayId)).status).toBe(400);
      const res = await reopenDay(t.admin, dayId, 'A sale was missed');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: 'reopened', reopenedBy: id.admin, reopenReason: 'A sale was missed' });
      expect((await reopenDay(t.admin, dayId, 'Again')).body.error).toBe('DAY_NOT_CLOSED');
      expect((await sell(t.sales, location.A)).status).toBe(201);

      const event = await one(`SELECT payload FROM outbox WHERE event_type = 'business_day.reopened' AND payload->>'businessDayId' = $1`, [String(dayId)]);
      expect(event.payload).toMatchObject({ branchId: branchA, day: localToday(), reason: 'A sale was missed' });
      await handleNotification({ ...event.payload, _eventType: 'business_day.reopened' });
      const note = await one(`SELECT body, target_roles FROM notifications WHERE event_type = 'business_day.reopened' AND entity_id = $1`, [String(dayId)]);
      expect(note.target_roles).toEqual(['Super_Admin', 'Finance_Officer']);
      expect(note.body).toContain('A sale was missed');
      expect(NOTIFICATION_EVENTS).toEqual(expect.arrayContaining(['business_day.reopened', 'business_month.reopened']));
      expect(HANDLERS['business_day.reopened']).toBe(handleNotification);
      expect(HANDLERS['business_month.reopened']).toBe(handleNotification);
    });

    it('closes again with the late sale, under a new number', async () => {
      const first = (await as(t.manager).get(`/api/v1/business-days/${dayId}`)).body.dayNumber;
      const res = await closeDay(t.finance, localToday());
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ id: dayId, status: 'closed', closedBy: id.finance, reopenedAt: null, reopenReason: null });
      expect(res.body.dayNumber).not.toBe(first);
      expect(res.body.report.sales.pos).toEqual({ count: 2, total: price * 2 });
    });
  });

  describe('a past day, its corrections and its month (decisions 1a, 3a, 4a, 5a)', () => {
    let saleId: string;
    let exchangeId: string;
    let poId: string;
    let paymentId: string;
    let dayId: number;
    let monthId: number;

    /** Moves the branch's records to the past day, as if they had been made then. */
    async function backdate(at: string) {
      const branch = [branchC];
      await db.query(`UPDATE transactions SET created_at = $2 WHERE branch_id = $1`, [...branch, at]);
      await db.query(`UPDATE transaction_payments SET created_at = $2 WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [...branch, at]);
      await db.query(`UPDATE exchanges SET created_at = $2 WHERE branch_id = $1`, [...branch, at]);
      await db.query(`UPDATE exchange_settlement_entries SET created_at = $2 WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [...branch, at]);
      await db.query(`UPDATE supplier_payments SET created_at = $2 WHERE branch_id = $1`, [...branch, at]);
      await db.query(`UPDATE inventory_history SET created_at = $2 WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [...branch, at]);
    }

    beforeAll(async () => {
      const sale = await sell(t.managerC, location.C);
      expect(sale.status, JSON.stringify(sale.body)).toBe(201);
      saleId = sale.body.id;
      // Paid at 01:30 on the 10th in Addis Ababa: still the 9th in UTC.
      await backdate('2001-02-09T22:30:00Z');
      const exchange = await as(t.managerC).post('/api/v1/exchanges', {
        locationId: location.C, incomingItems: [{ bookId, quantity: 1, unitPrice: 2 }], refundMethod: 'cash',
      });
      expect(exchange.status, JSON.stringify(exchange.body)).toBe(201);
      exchangeId = exchange.body.id;
      const supplierId = (await one(
        `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type) VALUES ($1, '{}', 7, 'external') RETURNING id`, [SUPPLIER],
      )).id;
      const po = await as(t.purchasorC).post('/api/v1/purchase-orders', { supplierId, lineItems: [{ bookId, quantity: 10, unitCost: 10 }] });
      expect(po.status, JSON.stringify(po.body)).toBe(201);
      poId = po.body.id;
      expect((await as(t.purchasorC).post(`/api/v1/purchase-orders/${poId}/submit`)).body.status).toBe('approved');
      const paid = await as(t.financeC).post(`/api/v1/purchase-orders/${poId}/payments`, { amount: 30, paymentMethod: 'bank' });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      paymentId = paid.body.payments[0].id;
      await db.query(`UPDATE exchanges SET created_at = '2001-02-10T10:00:00+03' WHERE branch_id = $1`, [branchC]);
      await db.query(`UPDATE exchange_settlement_entries SET created_at = '2001-02-10T10:00:00+03' WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchC]);
      await db.query(`UPDATE supplier_payments SET created_at = '2001-02-10T11:00:00+03' WHERE branch_id = $1`, [branchC]);
      await db.query(`UPDATE inventory_history SET created_at = '2001-02-10T10:00:00+03' WHERE location_id = $1 AND created_at > '2002-01-01'`, [location.C]);
    });

    it('counts what happened on the shop\'s local day (was: the UTC day)', async () => {
      const res = await preview(t.managerC, PAST_DAY);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.report.sales.pos).toEqual({ count: 1, total: price });
      expect(res.body.report.sales.exchanges).toEqual({ count: 1 });
      expect(res.body.report.money.byMethod).toEqual(expect.arrayContaining([
        { method: 'cash', in: price, out: 2 },
        { method: 'bank', in: 0, out: 30 },
      ]));
      expect((await preview(t.managerC, '2001-02-09')).body.report.sales.pos.count).toBe(0);
    });

    it('closes a month only once it has ended', async () => {
      const res = await closeMonth(t.financeC, localToday().slice(0, 7));
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('MONTH_NOT_ENDED');
    });

    it('closes a month only when every branch has closed the days it worked', async () => {
      const before = await monthPreview(t.financeC, MONTH);
      expect(before.status, JSON.stringify(before.body)).toBe(200);
      expect(before.body).toMatchObject({ month: MONTH, status: 'open', ended: true });
      expect(before.body.openDays).toEqual([{ branchId: branchC, branchName: `${BRANCH_PREFIX}C`, days: [PAST_DAY] }]);
      const refused = await closeMonth(t.financeC, MONTH);
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('MONTH_HAS_OPEN_DAYS');
      expect(refused.body.details.openDays).toEqual(before.body.openDays);
    });

    it('closes a past day', async () => {
      const res = await closeDay(t.managerC, PAST_DAY);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      dayId = res.body.id;
      expect(res.body.report.sales.pos.count).toBe(1);
    });

    it('refuses to change a closed day in place; corrections are new documents (decision 3a)', async () => {
      // Sales and exchanges are voided on their own day only; later they are returned.
      expect((await as(t.managerC).post(`/api/v1/pos/transactions/${saleId}/void`)).body.error).toBe('VOID_WINDOW_CLOSED');
      expect((await as(t.managerC).post(`/api/v1/exchanges/${exchangeId}/void`, { reason: 'Wrong book' })).body.error).toBe('VOID_WINDOW_CLOSED');
      const reversed = await as(t.financeC).post(`/api/v1/purchase-orders/${poId}/payments/${paymentId}/reverse`, { reason: 'Wrong order' });
      expect(reversed.status).toBe(409);
      expect(reversed.body.error).toBe('DAY_CLOSED');
      expect((await one(`SELECT status FROM transactions WHERE id = $1`, [saleId])).status).toBe('completed');
      expect((await one(`SELECT reversed_at FROM supplier_payments WHERE id = $1`, [paymentId])).reversed_at).toBeNull();
    });

    it('is for a Finance_Officer or Admin, and keeps the month summary', async () => {
      expect((await closeMonth(t.managerC, MONTH)).status).toBe(403);
      const res = await closeMonth(t.financeC, MONTH);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      monthId = res.body.id;
      expect(res.body).toMatchObject({ month: MONTH, status: 'closed', closedBy: id.financeC });
      expect(res.body.summary.branches).toEqual([
        expect.objectContaining({ branchId: branchC, days: 1, sales: price, moneyIn: price, moneyOut: 32, cashVariance: 0 }),
      ]);
      expect(res.body.summary.totals).toMatchObject({ days: 1, sales: price });
      expect((await closeMonth(t.adminC, MONTH)).body.error).toBe('MONTH_ALREADY_CLOSED');
      const list = await as(t.financeC).get('/api/v1/business-months?year=2001');
      expect(list.body.items).toEqual([expect.objectContaining({ id: monthId, month: MONTH, status: 'closed' })]);
    });

    it('locks its days: a day reopens only after its month (decision 5a)', async () => {
      const day = await reopenDay(t.adminC, dayId, 'Wrong count');
      expect(day.status).toBe(409);
      expect(day.body.error).toBe('MONTH_CLOSED');
      const reversed = await as(t.financeC).post(`/api/v1/purchase-orders/${poId}/payments/${paymentId}/reverse`, { reason: 'Wrong order' });
      expect(reversed.body.error).toBe('MONTH_CLOSED');
    });

    it('reopens a month for an Admin only, with a reason, and tells Super_Admin and Finance', async () => {
      expect((await reopenMonth(t.financeC, monthId, 'Wrong count')).status).toBe(403);
      expect((await reopenMonth(t.adminC, monthId, '  ')).status).toBe(400);
      const res = await reopenMonth(t.adminC, monthId, 'Supplier invoice missed');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: 'reopened', reopenedBy: id.adminC, reopenReason: 'Supplier invoice missed' });
      const audit = await one(`SELECT meta FROM audit_logs WHERE entity_type = 'business_month' AND entity_id = $1 AND meta->>'action' = 'reopen'`, [String(monthId)]);
      expect(audit.meta).toMatchObject({ reason: 'Supplier invoice missed', month: MONTH });
      const event = await one(`SELECT payload FROM outbox WHERE event_type = 'business_month.reopened' AND payload->>'businessMonthId' = $1`, [String(monthId)]);
      await handleNotification({ ...event.payload, _eventType: 'business_month.reopened' });
      const note = await one(`SELECT body, target_roles FROM notifications WHERE event_type = 'business_month.reopened' AND entity_id = $1`, [String(monthId)]);
      expect(note.target_roles).toEqual(['Super_Admin', 'Finance_Officer']);
      expect(note.body).toContain('Supplier invoice missed');

      expect((await reopenDay(t.adminC, dayId, 'Wrong count')).status).toBe(200);
      const reversed = await as(t.financeC).post(`/api/v1/purchase-orders/${poId}/payments/${paymentId}/reverse`, { reason: 'Wrong order' });
      expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    });
  });
});
