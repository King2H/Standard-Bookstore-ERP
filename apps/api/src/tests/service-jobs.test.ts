/**
 * service-jobs.test.ts
 *
 * #169 PR 3 (owner decisions 1a, 2a, 3a, 4a, 2026-10-26): after the sale.
 * The branch's binding jobs are listed on one board, by status, overdue and
 * job number or customer, with the customer's phone to call (1a). A job
 * that is ready tells the branch's selling roles (2a). A Manager or Admin
 * cancels a binding still Requested, with a reason: the fee goes back the
 * way it was paid, as a return of the fee, and the copy is an ordinary one
 * from then on (3a). A bound copy comes back only defective, with a reason
 * and a Manager or Admin: the book and its share of the fee go back, the
 * copy is kept apart as damaged, and the binding's cost stays a loss (4a).
 * Before, none of this existed: a bound copy could not be returned at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';
import { handleNotification, NOTIFICATION_EVENTS } from '../workers/notificationWorker.js';
import { HANDLERS } from '../workers/outboxPoller.js';

const STAFF_PREFIX = 'svcjobs_test_';
const BRANCH_PREFIX = 'Service Jobs ';
const CODE = 'SVCJOBS';

describe('Binding jobs after the sale', () => {
  let branchId: number;
  let otherBranch: number;
  let locationId: number;
  let bookId: number;
  let price: number;
  let customerId: number;
  let cloth: number;
  let sales: string;
  let manager: string;
  let clerk: string;
  let otherManager: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = manager, branch = branchId) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branch));
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const stockOf = async () => one(`SELECT quantity, damaged_quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    const txs = `SELECT id FROM transactions WHERE branch_id IN (${branches})`;
    const customers = `SELECT id FROM customers WHERE full_name LIKE '${CODE}%'`;
    for (const statement of [
      `DELETE FROM notifications WHERE branch_id IN (${branches})`,
      `DELETE FROM return_service_lines WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM order_refunds WHERE order_id IN (${orders})`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM service_jobs WHERE branch_id IN (${branches})`,
      `DELETE FROM sale_service_lines WHERE transaction_line_item_id IN (SELECT id FROM transaction_line_items WHERE transaction_id IN (${txs}))
         OR order_line_item_id IN (SELECT id FROM order_line_items WHERE order_id IN (${orders}))`,
      `DELETE FROM order_payments WHERE order_id IN (${orders})`,
      `DELETE FROM financial_transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${orders})`,
      `DELETE FROM order_line_items WHERE order_id IN (${orders})`,
      `DELETE FROM orders WHERE id IN (${orders})`,
      `DELETE FROM transaction_payments WHERE transaction_id IN (${txs})`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (${txs})`,
      `DELETE FROM transactions WHERE id IN (${txs})`,
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

  /** A counter sale for the customer: `quantity` copies, `bound` of them in cloth, paid in cash unless on credit. */
  async function sell(quantity: number, bound: number, opts: { credit?: boolean } = {}) {
    const total = price * quantity + 100 * bound;
    const res = await as(api().post('/api/v1/pos/transactions'), sales).send({
      locationId, customerId,
      items: [{ bookId, quantity, ...(bound > 0 && { service: { serviceId: cloth, quantity: bound } }) }],
      payments: opts.credit ? [] : [{ method: 'cash', amount: total }],
      ...(opts.credit && { allowCredit: true, dueDate: '2099-12-31' }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const line = res.body.lineItems[0];
    return { id: String(res.body.id), number: res.body.transactionNumber as string, lineId: Number(line.id), job: line.service?.job?.id as number, total };
  }
  const step = (job: number, s: string, token = sales) => as(api().post(`/api/v1/service-jobs/${job}/${s}`), token);
  const collect = async (job: number) => { for (const s of ['send', 'ready', 'collect']) expect((await step(job, s)).status).toBe(200); };
  const cancelBinding = (job: number, body: object = { reason: 'Customer changed their mind' }, token = manager) =>
    as(api().post(`/api/v1/service-jobs/${job}/cancel`), token).send(body);
  const giveBack = (saleId: string, lineId: number, quantity: number, extra: object = {}, token = manager) =>
    as(api().post('/api/v1/returns'), token).send({
      transactionId: Number(saleId), reason: 'Spine came loose', lines: [{ transactionLineItemId: lineId, quantity, ...extra }],
    });

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    otherBranch = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    clerk = (await createTestStaff({ username: `${STAFF_PREFIX}clerk`, role: 'Stock_Clerk', branchId })).token;
    otherManager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr_b`, role: 'Manager', branchId: otherBranch })).token;
    locationId = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Service Jobs Loc', true) RETURNING id`, [branchId])).id;
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, 100, 5, 0, 4)`, [bookId, locationId]);
    const customer = await as(api().post('/api/v1/customers')).send({ fullName: `${CODE} Almaz Bekele`, phone: '0911223344' });
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

  describe('the jobs board (1a)', () => {
    let job: number;
    let saleNumber: string;

    beforeAll(async () => {
      const sale = await sell(1, 1);
      job = sale.job;
      saleNumber = sale.number;
    });

    it('lists the branch\'s jobs with the book, the binding, the customer to call and the sale (was: no board)', async () => {
      const res = await as(api().get('/api/v1/service-jobs'), sales);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = res.body.items.find((j: { id: number }) => j.id === job);
      expect(row).toMatchObject({
        status: 'REQUESTED', serviceName: 'Cloth binding', quantity: 1, bookTitle: expect.any(String),
        customerName: `${CODE} Almaz Bekele`, customerPhone: '0911223344', source: 'POS', saleNumber, overdue: false,
      });
      expect(row.jobNumber).toMatch(/^SVC-\d{8}-\d{4}$/);
    });

    it('filters by status, by overdue and by job number or customer', async () => {
      const ids = async (query: string) => (await as(api().get(`/api/v1/service-jobs?${query}`), sales)).body.items.map((j: { id: number }) => j.id);
      expect(await ids('status=REQUESTED')).toContain(job);
      expect(await ids('status=READY')).not.toContain(job);
      expect(await ids('q=Almaz')).toContain(job);
      expect(await ids('q=nobody-by-this-name')).toEqual([]);
      const number = (await one(`SELECT job_number FROM service_jobs WHERE id = $1`, [job])).job_number;
      expect(await ids(`q=${number}`)).toEqual([job]);
      expect(await ids('overdue=true')).not.toContain(job);
      await db.query(`UPDATE service_jobs SET ready_date = CURRENT_DATE - 1 WHERE id = $1`, [job]);
      expect(await ids('overdue=true')).toContain(job);
      await db.query(`UPDATE service_jobs SET ready_date = CURRENT_DATE + 3 WHERE id = $1`, [job]);
    });

    it('is for the selling roles of the branch', async () => {
      expect((await as(api().get('/api/v1/service-jobs'), clerk)).status).toBe(403);
      const elsewhere = await as(api().get('/api/v1/service-jobs'), otherManager, otherBranch);
      expect(elsewhere.body.items.map((j: { id: number }) => j.id)).not.toContain(job);
    });

    it('tells the selling roles of the branch when a job is ready (2a)', async () => {
      await step(job, 'send');
      await step(job, 'ready');
      const event = await one(`SELECT payload FROM outbox WHERE event_type = 'service_job.ready' AND payload->>'jobId' = $1`, [String(job)]);
      expect(event.payload).toMatchObject({ branchId, customerName: `${CODE} Almaz Bekele` });
      await handleNotification({ ...event.payload, _eventType: 'service_job.ready' });
      const note = await one(`SELECT title, body, target_roles, branch_id FROM notifications WHERE event_type = 'service_job.ready' AND entity_id = $1`, [String(job)]);
      expect(note).toMatchObject({ branch_id: branchId, target_roles: ['Sales', 'Manager', 'Admin'] });
      expect(note.body).toContain(`${CODE} Almaz Bekele`);
      // The phone stays encrypted at rest (#90): the board shows it, the notification does not.
      expect(note.body).not.toContain('0911223344');
    });

    it('is routed by the outbox poller to the notification worker, as every notification event is', () => {
      // Found end to end: the event was published but routed nowhere, so no one was told.
      expect(NOTIFICATION_EVENTS).toContain('service_job.ready');
      expect(NOTIFICATION_EVENTS.filter((type) => HANDLERS[type] !== handleNotification)).toEqual([]);
    });
  });

  describe('cancelling a binding still Requested (3a)', () => {
    it('gives the fee back the way it was paid, as a return of the fee; the copy is an ordinary one from then on', async () => {
      const sale = await sell(2, 1);
      const refused = await cancelBinding(sale.job, {}, manager);
      expect(refused.status).toBe(400);
      expect((await cancelBinding(sale.job, undefined, sales)).status).toBe(403);
      const res = await cancelBinding(sale.job);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED' });
      const ret = await one(
        `SELECT r.total_refund_amount, r.refund_method, r.reason, (SELECT COUNT(*) FROM return_line_items li WHERE li.return_id = r.id)::int AS book_lines,
                (SELECT quantity || ' ' || amount || ' ' || cost_reversed || ' ' || kind FROM return_service_lines s WHERE s.return_id = r.id) AS fee
         FROM returns r WHERE r.transaction_id = $1`,
        [sale.id],
      );
      expect(ret).toMatchObject({ total_refund_amount: '100.00', refund_method: 'cash', reason: 'Customer changed their mind', book_lines: 0, fee: '1 100.00 40.00 CANCELLED' });
      // Both copies are ordinary now: one comes back like any book.
      const back = await giveBack(sale.id, sale.lineId, 2);
      expect(back.status, JSON.stringify(back.body)).toBe(201);
    });

    it('takes the fee off what a credit sale still owes', async () => {
      const sale = await sell(1, 1, { credit: true });
      expect((await cancelBinding(sale.job)).status).toBe(200);
      const owed = await one(`SELECT amount_due FROM transactions WHERE id = $1`, [sale.id]);
      expect(Number(owed.amount_due)).toBe(price);
      const refund = await one(`SELECT f.method, f.amount FROM refunds f JOIN returns r ON r.id = f.return_id WHERE r.transaction_id = $1`, [sale.id]);
      expect(refund).toMatchObject({ method: 'credit_note', amount: '100.00' });
    });

    it('gives an order\'s fee back through its payments, before delivery; the order is then delivered as usual', async () => {
      const created = await as(api().post('/api/v1/orders'), sales).send({
        locationId, customerId, saleType: 'cash_sale', items: [{ bookId, quantity: 1, service: { serviceId: cloth, quantity: 1 } }],
      });
      const orderId = String(created.body.id);
      const confirmed = await as(api().post(`/api/v1/orders/${orderId}/confirm`), sales).send({ paymentMethod: 'cash' });
      const job = confirmed.body.lineItems[0].service.job.id;
      expect((await cancelBinding(job)).status).toBe(200);
      const refunded = await one(`SELECT COALESCE(SUM(refund_amount), 0)::numeric AS r FROM order_refunds WHERE order_id = $1`, [orderId]);
      expect(Number(refunded.r)).toBe(100);
      const delivered = await as(api().post(`/api/v1/orders/${orderId}/fulfill`));
      expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    });

    it('is refused once the work has started', async () => {
      const sale = await sell(1, 1);
      await step(sale.job, 'send');
      const res = await cancelBinding(sale.job);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('SERVICE_JOB_IN_PROGRESS');
    });
  });

  describe('a bound copy that comes back defective (4a)', () => {
    it('takes back the book and its share of the fee, keeps the copy apart as damaged; the binding\'s cost stays a loss', async () => {
      const sale = await sell(3, 2);
      await collect(sale.job);
      const before = await stockOf();

      const plain = await giveBack(sale.id, sale.lineId, 2);
      expect(plain.status).toBe(422);
      expect(plain.body.error).toBe('BOUND_COPY_RETURN');
      expect((await giveBack(sale.id, sale.lineId, 1, { defective: true }, sales)).body.error).toBe('APPROVAL_REQUIRED');

      const res = await giveBack(sale.id, sale.lineId, 1, { defective: true });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      // The fee is 100 a copy: one bound copy takes 100 of the 200.
      expect(res.body.totalRefundAmount).toBe(price + 100);
      const after = await stockOf();
      expect([after.quantity - before.quantity, after.damaged_quantity - before.damaged_quantity]).toEqual([0, 1]);
      const fee = await one(`SELECT quantity, amount, cost_reversed, kind FROM return_service_lines WHERE return_id = $1`, [res.body.id]);
      expect(fee).toMatchObject({ quantity: 1, amount: '100.00', cost_reversed: '0.00', kind: 'DEFECT' });
      expect((await one(`SELECT status FROM service_jobs WHERE id = $1`, [sale.job])).status).toBe('COLLECTED');

      // The last bound copy takes the rest of the fee and closes the job; the unbound copy returns as usual.
      const last = await giveBack(sale.id, sale.lineId, 1, { defective: true });
      expect(last.body.totalRefundAmount).toBe(price + 100);
      expect((await one(`SELECT status FROM service_jobs WHERE id = $1`, [sale.job])).status).toBe('RETURNED');
      expect((await giveBack(sale.id, sale.lineId, 1)).status).toBe(201);
    });

    it('needs a reason, and the copy back from the customer', async () => {
      const sale = await sell(1, 1);
      const notCollected = await giveBack(sale.id, sale.lineId, 1, { defective: true });
      expect(notCollected.status).toBe(422);
      expect(notCollected.body.error).toBe('BOUND_COPY_NOT_COLLECTED');
      await collect(sale.job);
      const noReason = await as(api().post('/api/v1/returns')).send({
        transactionId: Number(sale.id), lines: [{ transactionLineItemId: sale.lineId, quantity: 1, defective: true }],
      });
      expect(noReason.status).toBe(400);
    });
  });

  describe('the sales report', () => {
    it('takes returned fees off net sales; a cancelled binding\'s cost comes back, a defective one\'s stays', async () => {
      const report = (await as(api().get('/api/v1/reports/sales'))).body.summary;
      const detail = (await as(api().get('/api/v1/reports/sales/detail'))).body;
      const fees = await one(
        `SELECT COALESCE(SUM(s.amount), 0)::numeric AS amount, COALESCE(SUM(s.cost_reversed), 0)::numeric AS cost
         FROM return_service_lines s JOIN returns r ON r.id = s.return_id WHERE r.branch_id = $1`,
        [branchId],
      );
      const rows = detail.rows.filter((r: { source: string; kind: string }) => r.source === 'RETURN' && r.kind === 'SERVICE');
      const sum = (key: 'netSalesAmount' | 'costAmount') => Number(rows.reduce((s: number, r: Record<string, number>) => s + r[key], 0).toFixed(2));
      expect(sum('netSalesAmount')).toBe(-Number(fees.amount));
      expect(sum('costAmount')).toBe(-Number(fees.cost));
      expect(report.netSales).toBe(Number((report.totalSales + report.totalPosSales - report.returnsValue).toFixed(2)));
      expect(detail.totals.netSalesAmount).toBe(report.netSales);
    });
  });
});
