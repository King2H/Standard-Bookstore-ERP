/**
 * exchange-services.test.ts
 *
 * #169 PR 4 (owner decisions 1a–5a, 2026-10-26): binding on the books an
 * exchange gives out. A binding is asked for on an outgoing line, for some or
 * all of its copies, at the branch's fee with no discount (2a), for a named
 * customer; its fee is part of what goes out, so it moves the difference
 * settled at the counter (3a). It opens a job like a counter sale's, shown on
 * the board as from the exchange (1a). Voiding the exchange cancels its jobs
 * while Requested and is refused once the work started (4a). A Manager or
 * Admin cancels a binding still Requested, with a reason: the fee goes first
 * against what the exchange left on credit, the rest to the customer's store
 * credit, recorded as a return of the fee (5a). Before, an exchange gave out
 * books only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'excsvc_test_';
const BRANCH_PREFIX = 'Exchange Services ';
const CODE = 'EXCSVC';

describe('Binding on an exchange', () => {
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

  /** An exchange giving out `quantity` copies, `bound` of them in cloth; paid in cash unless left on credit. */
  async function exchange(quantity: number, bound: number, opts: { credit?: boolean; customer?: number | null; service?: object } = {}) {
    const total = money(price * quantity + 100 * bound);
    const res = await as(api().post('/api/v1/exchanges'), sales).send({
      locationId,
      customerId: opts.customer === undefined ? customerId : opts.customer,
      outgoingItems: [{ bookId, quantity, ...(bound > 0 && { service: { serviceId: cloth, quantity: bound, ...opts.service } }) }],
      payments: opts.credit ? [] : [{ method: 'cash', amount: total }],
      ...(opts.credit && { allowCredit: true, dueDate: '2099-12-31' }),
    });
    return { res, total };
  }
  async function made(quantity: number, bound: number, opts: { credit?: boolean } = {}) {
    const { res, total } = await exchange(quantity, bound, opts);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id as string, reference: res.body.exchangeReference as string, job: res.body.outgoingItems[0].service?.job?.id as number, total, body: res.body };
  }
  const step = (job: number, s: string, token = sales) => as(api().post(`/api/v1/service-jobs/${job}/${s}`), token);
  const cancelBinding = (job: number, token = manager) =>
    as(api().post(`/api/v1/service-jobs/${job}/cancel`), token).send({ reason: 'Customer changed their mind' });
  const storeCredit = async () => Number((await one(`SELECT COALESCE((SELECT balance FROM store_credit_accounts WHERE customer_id = $1), 0) AS b`, [customerId])).b);

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    locationId = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Exchange Services Loc', true) RETURNING id`, [branchId])).id;
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, 100, 5, 0, 4)`, [bookId, locationId]);
    const customer = await as(api().post('/api/v1/customers')).send({ fullName: `${CODE} Tsehay Worku`, phone: '0911556677' });
    expect(customer.status, JSON.stringify(customer.body)).toBe(201);
    customerId = customer.body.id;
    const formatId = (await one(`SELECT id FROM book_formats ORDER BY id LIMIT 1`)).id;
    const created = await as(api().post('/api/v1/services')).send({
      code: `${CODE}-CLOTH`, name: 'Cloth binding', formatId, fee: 100, standardCost: 40, discountable: true, turnaroundDays: 3,
    });
    expect(created.status).toBe(201);
    cloth = created.body.id;
  });

  afterAll(cleanUp);

  describe('on an outgoing book (1a, 2a, 3a)', () => {
    it('adds the fee to what goes out, opens a job, and shows it on the exchange and the board (was: books only)', async () => {
      const e = await made(2, 1);
      expect(e.body).toMatchObject({ totalOutgoingValue: e.total, netBalance: e.total, settlementType: 'Customer_Pays' });
      expect(e.body.outgoingItems[0].service).toMatchObject({
        serviceName: 'Cloth binding', quantity: 1, unitFee: 100, discountAmount: 0, lineTotal: 100, standardCost: 40,
        job: { status: 'REQUESTED', customerId },
      });
      const detail = await as(api().get(`/api/v1/exchanges/${e.id}`), sales);
      expect(detail.body.outgoingItems[0].service.job.id).toBe(e.job);

      const board = await as(api().get('/api/v1/service-jobs'), sales);
      expect(board.body.items.find((j: { id: number }) => j.id === e.job)).toMatchObject({
        source: 'EXCHANGE', saleId: e.id, saleNumber: e.reference, customerName: `${CODE} Tsehay Worku`, customerPhone: '0911556677', quantity: 1,
      });
    });

    it('charges the branch\'s fee with no discount, as exchanges carry none', async () => {
      const e = await made(1, 1);
      await made(1, 0);
      const { res } = await exchange(1, 1, { service: { discountPct: 50 } });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.outgoingItems[0].service).toMatchObject({ unitFee: 100, discountAmount: 0, lineTotal: 100 });
      expect(e.body.outgoingItems[0].service.lineTotal).toBe(100);
    });

    it('needs a named customer, and no more copies than the line gives out', async () => {
      const walkIn = await exchange(1, 1, { customer: null });
      expect(walkIn.res.status).toBe(422);
      expect(walkIn.res.body.error).toBe('SERVICE_REQUIRES_CUSTOMER');
      const tooMany = await exchange(1, 2);
      expect(tooMany.res.status).toBe(422);
      expect(tooMany.res.body.error).toBe('SERVICE_QUANTITY_EXCEEDS_BOOKS');
    });
  });

  describe('voiding the exchange (4a)', () => {
    it('cancels its job while Requested', async () => {
      const e = await made(1, 1);
      const res = await as(api().post(`/api/v1/exchanges/${e.id}/void`)).send({ reason: 'Wrong book' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await one(`SELECT status FROM service_jobs WHERE id = $1`, [e.job])).status).toBe('CANCELLED');
    });

    it('is refused once the work started', async () => {
      const e = await made(1, 1);
      expect((await step(e.job, 'send')).status).toBe(200);
      const res = await as(api().post(`/api/v1/exchanges/${e.id}/void`)).send({ reason: 'Wrong book' });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('SERVICE_JOB_IN_PROGRESS');
      expect((await one(`SELECT voided_at FROM exchanges WHERE id = $1`, [e.id])).voided_at).toBeNull();
    });
  });

  describe('cancelling the binding (5a)', () => {
    it('gives the fee to the customer\'s store credit on a paid exchange, as a return of the fee', async () => {
      const e = await made(1, 1);
      expect((await cancelBinding(e.job, sales)).status).toBe(403);
      const before = await storeCredit();
      const res = await cancelBinding(e.job);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(await storeCredit()).toBe(money(before + 100));
      const ret = await one(
        `SELECT r.exchange_id, r.total_refund_amount, r.refund_method, r.customer_id, rs.quantity, rs.amount, rs.cost_reversed, rs.kind
         FROM returns r JOIN return_service_lines rs ON rs.return_id = r.id WHERE r.exchange_id = $1`, [e.id]);
      expect(ret).toMatchObject({
        exchange_id: e.id, total_refund_amount: '100.00', refund_method: 'store_credit', customer_id: customerId,
        quantity: 1, amount: '100.00', cost_reversed: '40.00', kind: 'CANCELLED',
      });
      const back = await as(api().get(`/api/v1/returns?customerId=${customerId}`));
      expect(back.body.items.find((r: { exchangeId: string | null }) => r.exchangeId === e.id)).toMatchObject({
        exchangeReference: e.reference, transactionId: null, orderId: null, totalRefundAmount: 100,
      });
    });

    it('sets the fee against what the exchange left on credit first', async () => {
      const e = await made(1, 1, { credit: true });
      const before = await storeCredit();
      expect((await cancelBinding(e.job)).status).toBe(200);
      const receivable = await one(`SELECT outstanding_amount FROM receivables WHERE source_type = 'exchange_difference' AND source_entity_id = $1`, [e.id]);
      expect(Number(receivable.outstanding_amount)).toBe(money(price));
      expect(await storeCredit()).toBe(before);
      expect((await one(`SELECT refund_method FROM returns WHERE exchange_id = $1`, [e.id])).refund_method).toBe('credit_note');
    });

    it('cannot be voided after, nor cancelled once the work started', async () => {
      const e = await made(1, 1);
      expect((await cancelBinding(e.job)).status).toBe(200);
      const voided = await as(api().post(`/api/v1/exchanges/${e.id}/void`)).send({ reason: 'Wrong book' });
      expect(voided.status).toBe(422);
      expect(voided.body.error).toBe('EXCHANGE_HAS_RETURNS');
      expect((await as(api().get(`/api/v1/exchanges/${e.id}`))).body.voidable).toBe(false);

      const started = await made(1, 1);
      expect((await step(started.job, 'send')).status).toBe(200);
      const refused = await cancelBinding(started.job);
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('SERVICE_JOB_IN_PROGRESS');
    });
  });

  describe('the sales report', () => {
    it('counts an exchange\'s fee as service income in the exchange, and a fee given back as a return', async () => {
      const res = await as(api().get(`/api/v1/reports/sales/detail?branchId=${branchId}`));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      type Row = { source: string; kind: string; netSalesAmount: number; costAmount: number; invoiceNo: string };
      const rows = res.body.rows as Row[];
      const fees = rows.filter((r) => r.source === 'EXCHANGE' && r.kind === 'SERVICE');
      const voided = (await db.query(`SELECT exchange_reference FROM exchanges WHERE branch_id = $1 AND voided_at IS NOT NULL`, [branchId])).rows.map((r) => r.exchange_reference);
      const standing = Number((await one(
        `SELECT COUNT(*) AS n FROM sale_service_lines sl JOIN exchange_outgoing_items eo ON eo.id = sl.exchange_outgoing_item_id
         JOIN exchanges e ON e.id = eo.exchange_id WHERE e.branch_id = $1 AND e.voided_at IS NULL`, [branchId])).n);
      expect(fees).toHaveLength(standing);
      expect(fees.every((r) => r.netSalesAmount === 100 && r.costAmount === 40 && !voided.includes(r.invoiceNo))).toBe(true);
      const feeReturns = rows.filter((r) => r.source === 'RETURN' && r.kind === 'SERVICE');
      // The three bindings cancelled above.
      expect(feeReturns.map((r) => [r.netSalesAmount, r.costAmount])).toEqual([[-100, -40], [-100, -40], [-100, -40]]);

      const summary = (await as(api().get(`/api/v1/reports/sales?branchId=${branchId}`))).body.summary;
      expect(summary.serviceIncome).toBe(money(100 * standing));
      expect(res.body.totals.netSalesAmount).toBe(summary.netSales);
      expect(res.body.totals.grossProfit).toBe(summary.grossProfit);
    });
  });
});
