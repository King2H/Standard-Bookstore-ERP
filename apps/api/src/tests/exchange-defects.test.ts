/**
 * exchange-defects.test.ts
 *
 * #203 (owner decisions 1a, 2a, 3a, 2026-10-26): a bound copy an exchange
 * gave out comes back through Returns when it is defective, as a counter
 * sale's or an order's does (#169 PR 3, 4a): once collected, by a Manager or
 * Admin, with a reason. Only bound copies come back this way; a plain copy is
 * swapped in a new exchange (1a). The book and its share of the fee go first
 * against what the exchange left on credit, the rest to the customer's store
 * credit (2a). The copy is kept apart as damaged at its cost; the binding's
 * cost stays a loss; the job is Returned once every bound copy is back; the
 * report shows the book and the fee as returned (3a). Before, an exchange's
 * bound copy had no way back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'excdef_test_';
const BRANCH_PREFIX = 'Exchange Defects ';
const CODE = 'EXCDEF';

describe('A defective bound copy from an exchange', () => {
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let price: number;
  let customerId: number;
  let cloth: number;
  let sales: string;
  let manager: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = manager) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const money = (n: number) => Number(n.toFixed(2));

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const exchanges = `SELECT id FROM exchanges WHERE branch_id IN (${branches})`;
    const customers = `SELECT id FROM customers WHERE full_name LIKE '${CODE}%'`;
    for (const statement of [
      `DELETE FROM notifications WHERE branch_id IN (${branches})`,
      `DELETE FROM return_service_lines WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM service_jobs WHERE branch_id IN (${branches})`,
      `DELETE FROM sale_service_lines WHERE exchange_outgoing_item_id IN (SELECT id FROM exchange_outgoing_items WHERE exchange_id IN (${exchanges}))`,
      `DELETE FROM exchange_settlement_entries WHERE exchange_id IN (${exchanges})`,
      `DELETE FROM exchange_outgoing_items WHERE exchange_id IN (${exchanges})`,
      `DELETE FROM exchange_incoming_items WHERE exchange_id IN (${exchanges})`,
      `DELETE FROM financial_transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM exchanges WHERE id IN (${exchanges})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM branch_config WHERE branch_id IN (${branches})`,
      `DELETE FROM service_branch_fees WHERE service_id IN (SELECT id FROM services WHERE code LIKE '${CODE}%')`,
      `DELETE FROM services WHERE code LIKE '${CODE}%'`,
      `DELETE FROM store_credit_history WHERE customer_id IN (${customers})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customers})`,
      `DELETE FROM loyalty_history WHERE customer_id IN (${customers})`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (${customers})`,
      `DELETE FROM customers WHERE id IN (${customers})`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  /** An exchange giving out `quantity` copies, `bound` of them in cloth (fee 100 each); paid in cash unless left on credit. */
  async function exchange(quantity: number, bound: number, opts: { credit?: boolean } = {}) {
    const total = money(price * quantity + 100 * bound);
    const res = await as(api().post('/api/v1/exchanges'), sales).send({
      locationId, customerId,
      outgoingItems: [{ bookId, quantity, ...(bound > 0 && { service: { serviceId: cloth, quantity: bound } }) }],
      payments: opts.credit ? [] : [{ method: 'cash', amount: total }],
      ...(opts.credit && { allowCredit: true, dueDate: '2099-12-31' }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const line = res.body.outgoingItems[0];
    return { id: res.body.id as string, reference: res.body.exchangeReference as string, lineId: Number(line.id), job: line.service?.job?.id as number };
  }
  const step = (job: number, s: string) => as(api().post(`/api/v1/service-jobs/${job}/${s}`), sales);
  const collect = async (job: number) => { for (const s of ['send', 'ready', 'collect']) expect((await step(job, s)).status).toBe(200); };
  const giveBack = (e: { id: string; lineId: number }, quantity: number, extra: object = {}, token = manager, reason: string | null = 'Spine came loose') =>
    as(api().post('/api/v1/returns'), token).send({
      exchangeId: Number(e.id), ...(reason !== null && { reason }), lines: [{ exchangeLineItemId: e.lineId, quantity, defective: true, ...extra }],
    });
  const storeCredit = async () => Number((await one(`SELECT COALESCE((SELECT balance FROM store_credit_accounts WHERE customer_id = $1), 0) AS b`, [customerId])).b);
  const damaged = async () => Number((await one(`SELECT damaged_quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId])).damaged_quantity);
  const jobStatus = async (job: number) => (await one(`SELECT status FROM service_jobs WHERE id = $1`, [job])).status;

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    locationId = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Exchange Defects Loc', true) RETURNING id`, [branchId])).id;
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, 100, 5, 0, 4)`, [bookId, locationId]);
    const customer = await as(api().post('/api/v1/customers')).send({ fullName: `${CODE} Selam Tadesse`, phone: '0911887766' });
    expect(customer.status, JSON.stringify(customer.body)).toBe(201);
    customerId = customer.body.id;
    const formatId = (await one(`SELECT id FROM book_formats ORDER BY id LIMIT 1`)).id;
    const created = await as(api().post('/api/v1/services')).send({
      code: `${CODE}-CLOTH`, name: 'Cloth binding', formatId, fee: 100, standardCost: 40, discountable: false, turnaroundDays: 3,
    });
    expect(created.status).toBe(201);
    cloth = created.body.id;
  });

  afterAll(cleanUp);

  it('is found by its number, to be returned against', async () => {
    const e = await exchange(1, 1);
    await exchange(1, 0);
    const res = await as(api().get(`/api/v1/exchanges?exchangeReference=${e.reference}`), sales);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.map((x: { id: string }) => x.id)).toEqual([e.id]);
  });

  it('comes back defective with the book and its share of the fee, to store credit, kept apart as damaged (was: no way back)', async () => {
    const e = await exchange(3, 2);
    await collect(e.job);
    const before = { credit: await storeCredit(), damaged: await damaged() };
    const res = await giveBack(e, 1);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      exchangeId: e.id, exchangeReference: e.reference, transactionId: null, orderId: null,
      totalRefundAmount: money(price + 100), refundMethod: 'store_credit', status: 'completed',
    });
    expect(await storeCredit()).toBe(money(before.credit + price + 100));
    expect(await damaged()).toBe(before.damaged + 1);
    const detail = await as(api().get(`/api/v1/returns/${res.body.id}`));
    expect(detail.body.lineItems).toEqual([expect.objectContaining({ exchangeLineItemId: String(e.lineId), quantity: 1, lineRefundAmount: price })]);
    expect(await one(`SELECT quantity, amount, cost_reversed, kind FROM return_service_lines WHERE return_id = $1`, [res.body.id]))
      .toEqual({ quantity: 1, amount: '100.00', cost_reversed: '0.00', kind: 'DEFECT' });
    // One of two bound copies back: the job stays Collected; the second closes it.
    expect(await jobStatus(e.job)).toBe('COLLECTED');
    expect((await giveBack(e, 1)).status).toBe(201);
    expect(await jobStatus(e.job)).toBe('RETURNED');

    // No bound copy is left, and the plain one is swapped in a new exchange (1a).
    const more = await giveBack(e, 1);
    expect(more.status).toBe(422);
    expect(more.body.error).toBe('BOUND_COPY_RETURN');
    const plain = await giveBack(e, 1, { defective: false });
    expect(plain.status).toBe(422);
    expect(plain.body.error).toBe('EXCHANGE_COPY_RETURN');
  });

  it('sets the value against what the exchange left on credit first', async () => {
    const e = await exchange(1, 1, { credit: true });
    await collect(e.job);
    const before = await storeCredit();
    const res = await giveBack(e, 1);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.refundMethod).toBe('credit_note');
    const receivable = await one(`SELECT outstanding_amount, status FROM receivables WHERE source_type = 'exchange_difference' AND source_entity_id = $1`, [e.id]);
    expect(receivable).toEqual({ outstanding_amount: '0.00', status: 'Settled' });
    expect(await storeCredit()).toBe(before);
  });

  it('is for a Manager or Admin, with a reason, once the customer has the copy; a copy with no binding is not taken', async () => {
    const e = await exchange(1, 1);
    const early = await giveBack(e, 1);
    expect(early.status).toBe(422);
    expect(early.body.error).toBe('BOUND_COPY_NOT_COLLECTED');
    await collect(e.job);
    const bySales = await giveBack(e, 1, {}, sales);
    expect(bySales.status).toBe(422);
    expect(bySales.body.error).toBe('APPROVAL_REQUIRED');
    expect((await giveBack(e, 1, {}, manager, null)).status).toBe(400);

    const unbound = await exchange(1, 0);
    const res = await giveBack(unbound, 1);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('EXCHANGE_COPY_RETURN');
    // Nothing moved on a refusal.
    expect(await one(`SELECT COUNT(*)::int AS n FROM returns WHERE exchange_id IN ($1, $2)`, [e.id, unbound.id])).toEqual({ n: 0 });
  });

  it('shows the book and the fee as returned in the sales report', async () => {
    const res = await as(api().get(`/api/v1/reports/sales/detail?branchId=${branchId}`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    type Row = { source: string; kind: string; netSalesAmount: number; costAmount: number; qty: number };
    const returned = (res.body.rows as Row[]).filter((r) => r.source === 'RETURN');
    // Three bound copies came back defective above, each a book row and a fee row.
    expect(returned.filter((r) => r.kind === 'BOOK').map((r) => [r.qty, r.netSalesAmount])).toEqual(Array(3).fill([-1, -price]));
    expect(returned.filter((r) => r.kind === 'SERVICE').map((r) => [r.netSalesAmount, r.costAmount])).toEqual(Array(3).fill([-100, 0]));
    const summary = (await as(api().get(`/api/v1/reports/sales?branchId=${branchId}`))).body.summary;
    expect(summary.returnsValue).toBe(money(3 * (price + 100)));
    expect(res.body.totals.netSalesAmount).toBe(summary.netSales);
    expect(res.body.totals.grossProfit).toBe(summary.grossProfit);
  });
});
