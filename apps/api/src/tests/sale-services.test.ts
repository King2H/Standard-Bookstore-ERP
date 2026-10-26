/**
 * sale-services.test.ts
 *
 * #169 PR 2 (owner decisions 1a, 2a, 3a, 4a, 5a, 6a, 2026-10-25): a sale
 * carries binding next to its books. A service line hangs off a book line
 * in POS and Orders (1a), for some or all of its copies (2a); its fee is
 * the branch's, discounted only when the service allows it and within the
 * cashier's line limit (3a). Each service line opens a job for the named
 * customer (SVC-YYYYMMDD-NNNN, a ready date), moved Requested -> At binder
 * -> Ready -> Collected; an order is delivered only once its jobs are
 * ready; a void or cancel while the job is still Requested gives back book
 * and fee; a bound copy is not returned yet (4a). An order's job opens at
 * confirmation (5a). The sales report counts the fee as service income, in
 * net sales and gross profit, so the report, its export lines and the sale
 * totals agree (6a). Before, a sale could carry books only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'salesvc_test_';
const BRANCH_PREFIX = 'Sale Services ';
const CUSTOMER_CODE = 'SALESVC-001';
const CODE = 'SALESVC';

describe('Services on a sale', () => {
  let branchId: number;
  let otherBranch: number;
  let locationId: number;
  let bookId: number;
  let price: number;
  let customerId: number;
  let leather: number;
  let cloth: number;
  let retired: number;
  let sales: string;
  let manager: string;
  let clerk: string;
  let otherManager: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = manager, branch = branchId) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branch));
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const onHand = async () => Number((await one(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId])).quantity);
  const today = async () => (await one(`SELECT TO_CHAR(CURRENT_DATE, 'YYYYMMDD') AS d, TO_CHAR(CURRENT_DATE + 5, 'YYYY-MM-DD') AS ready`));

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    const txs = `SELECT id FROM transactions WHERE branch_id IN (${branches})`;
    const customer = `SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`;
    for (const statement of [
      `DELETE FROM service_jobs WHERE branch_id IN (${branches})`,
      `DELETE FROM sale_service_lines WHERE transaction_line_item_id IN (SELECT id FROM transaction_line_items WHERE transaction_id IN (${txs}))
         OR order_line_item_id IN (SELECT id FROM order_line_items WHERE order_id IN (${orders}))`,
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM order_refunds WHERE order_id IN (${orders})`,
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
      `DELETE FROM store_credit_history WHERE customer_id IN (${customer})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customer})`,
      `DELETE FROM loyalty_history WHERE customer_id IN (${customer})`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (${customer})`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    await db.query(`DELETE FROM customers WHERE customer_code = $1`, [CUSTOMER_CODE]);
  }

  const posItem = (quantity: number, service?: object) => ({ bookId, quantity, ...(service && { service }) });
  /** A counter sale paid in cash, for the customer unless told otherwise. */
  function sell(items: object[], opts: { amount?: number; customer?: number | null; token?: string } = {}) {
    const body = { locationId, customerId: opts.customer === undefined ? customerId : opts.customer, items, payments: [] as object[] };
    if (opts.amount !== undefined) body.payments = [{ method: 'cash', amount: opts.amount }];
    return as(api().post('/api/v1/pos/transactions'), opts.token ?? sales).send(body);
  }
  const step = (jobId: number, action: string, token = sales) => as(api().post(`/api/v1/service-jobs/${jobId}/${action}`), token);

  async function newOrder(items: object[], opts: { confirm?: boolean } = {}) {
    const created = await as(api().post('/api/v1/orders'), sales).send({ locationId, customerId, saleType: 'cash_sale', items });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body.id);
    if (opts.confirm !== false) expect((await as(api().post(`/api/v1/orders/${id}/confirm`), sales).send({ paymentMethod: 'cash' })).status).toBe(200);
    return (await as(api().get(`/api/v1/orders/${id}`))).body;
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    otherBranch = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    clerk = (await createTestStaff({ username: `${STAFF_PREFIX}clerk`, role: 'Stock_Clerk', branchId })).token;
    otherManager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr_b`, role: 'Manager', branchId: otherBranch })).token;
    locationId = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Sale Services Loc', true) RETURNING id`, [branchId])).id;
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, 100, 5, 0, 4)`, [bookId, locationId]);
    customerId = (await one(`INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Sale Services Customer', $1, true) RETURNING id`, [CUSTOMER_CODE])).id;
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 0)`, [customerId]);
    const formatId = (await one(`SELECT id FROM book_formats ORDER BY id LIMIT 1`)).id;
    const service = async (code: string, fee: number, cost: number, discountable: boolean) => {
      const res = await as(api().post('/api/v1/services')).send({ code, name: `${code} binding`, formatId, fee, standardCost: cost, discountable, turnaroundDays: 5 });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as number;
    };
    leather = await service(`${CODE}-LEATHER`, 250, 120, false);
    cloth = await service(`${CODE}-CLOTH`, 100, 40, true);
    retired = await service(`${CODE}-OLD`, 80, 30, false);
    expect((await as(api().post(`/api/v1/services/${retired}/deactivate`))).status).toBe(200);
    // This branch charges its own fee for leather (2a of PR 1); the other branch the shop's.
    expect((await as(api().put(`/api/v1/services/${leather}/branch-fee`)).send({ fee: 280 })).status).toBe(200);
  });

  afterAll(cleanUp);

  describe('a counter sale with binding (1a, 2a, 3a, 4a)', () => {
    it('adds the fee to the sale, keeps it on its own line under the book, and opens a job for the customer (was: books only)', async () => {
      const before = await onHand();
      const res = await sell([posItem(3, { serviceId: leather, quantity: 2 })], { amount: price * 3 + 560 });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ subtotal: price * 3 + 560, grandTotal: price * 3 + 560, paymentStatus: 'paid' });
      const line = res.body.lineItems[0];
      expect(line).toMatchObject({ quantity: 3, lineTotal: price * 3 });
      const d = await today();
      expect(line.service).toMatchObject({
        serviceId: leather, serviceCode: `${CODE}-LEATHER`, quantity: 2, unitFee: 280, discountAmount: 0, lineTotal: 560, standardCost: 120,
        job: { status: 'REQUESTED', readyDate: d.ready, customerId },
      });
      expect(line.service.job.jobNumber).toMatch(new RegExp(`^SVC-${d.d}-\\d{4}$`));
      // The books leave stock as before; the service moves none.
      expect(await onHand()).toBe(before - 3);
      const audit = await one(`SELECT action, meta FROM audit_logs WHERE entity_type = 'service_job' AND entity_id = $1`, [String(line.service.job.id)]);
      expect(audit).toMatchObject({ action: 'CREATE' });
    });

    it('needs a named customer, an active service and no more copies than the line has', async () => {
      const walkIn = await sell([posItem(1, { serviceId: leather, quantity: 1 })], { amount: price + 280, customer: null });
      expect(walkIn.status).toBe(422);
      expect(walkIn.body.error).toBe('SERVICE_REQUIRES_CUSTOMER');
      const inactive = await sell([posItem(1, { serviceId: retired, quantity: 1 })], { amount: price + 80 });
      expect(inactive.status).toBe(422);
      expect(inactive.body.error).toBe('SERVICE_INACTIVE');
      const tooMany = await sell([posItem(1, { serviceId: leather, quantity: 2 })], { amount: price + 560 });
      expect(tooMany.status).toBe(422);
      expect(tooMany.body.error).toBe('SERVICE_QUANTITY_EXCEEDS_BOOKS');
      const unknown = await sell([posItem(1, { serviceId: 9999999, quantity: 1 })], { amount: price + 1 });
      expect(unknown.status).toBe(404);
    });

    it('discounts the fee only when the service allows it, within the cashier\'s line limit (3a)', async () => {
      const refused = await sell([posItem(1, { serviceId: leather, quantity: 1, discountPct: 10 })], { amount: price + 252 });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('FEE_NOT_DISCOUNTABLE');
      const tooMuch = await sell([posItem(1, { serviceId: cloth, quantity: 1, discountPct: 90 })], { amount: price + 10 });
      expect(tooMuch.status).toBe(422);
      expect(tooMuch.body.error).toBe('DISCOUNT_EXCEEDS_LIMIT');
      const ok = await sell([posItem(1, { serviceId: cloth, quantity: 1, discountPct: 10 })], { amount: price + 90 });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body.lineItems[0].service).toMatchObject({ unitFee: 100, discountAmount: 10, lineTotal: 90 });
      expect(ok.body).toMatchObject({ grandTotal: price + 90, discountTotal: 10 });
    });

    it('moves the job At binder -> Ready -> Collected, in order, by the selling roles of the sale\'s branch, audited', async () => {
      const sale = await sell([posItem(1, { serviceId: cloth, quantity: 1 })], { amount: price + 100 });
      const job = sale.body.lineItems[0].service.job.id as number;
      const early = await step(job, 'collect');
      expect(early.status).toBe(422);
      expect(early.body.error).toBe('INVALID_JOB_STEP');
      expect((await step(job, 'send', clerk)).status).toBe(403);
      expect((await step(job, 'send', otherManager).set('X-Branch-Id', String(otherBranch))).status).toBe(404);
      expect((await step(job, 'send')).body).toMatchObject({ status: 'AT_BINDER' });
      expect((await step(job, 'ready')).body).toMatchObject({ status: 'READY' });
      expect((await step(job, 'collect')).body).toMatchObject({ status: 'COLLECTED' });
      const actions = (await db.query(`SELECT meta->>'toStatus' AS s FROM audit_logs WHERE entity_type = 'service_job' AND entity_id = $1 AND action = 'UPDATE' ORDER BY id`, [String(job)])).rows;
      expect(actions.map((a) => a.s)).toEqual(['AT_BINDER', 'READY', 'COLLECTED']);
      const read = await as(api().get(`/api/v1/pos/transactions/${sale.body.id}`));
      expect(read.body.lineItems[0].service.job.status).toBe('COLLECTED');
    });

    it('voids a sale whose job is still Requested: book and fee back, the job cancelled; refused once at the binder', async () => {
      const sale = await sell([posItem(1, { serviceId: cloth, quantity: 1 })], { amount: price + 100 });
      const voided = await as(api().post(`/api/v1/pos/transactions/${sale.body.id}/void`));
      expect(voided.status, JSON.stringify(voided.body)).toBe(200);
      expect(voided.body.lineItems[0].service.job.status).toBe('CANCELLED');

      const sent = await sell([posItem(1, { serviceId: cloth, quantity: 1 })], { amount: price + 100 });
      await step(sent.body.lineItems[0].service.job.id, 'send');
      const refused = await as(api().post(`/api/v1/pos/transactions/${sent.body.id}/void`));
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('SERVICE_JOB_IN_PROGRESS');
    });

    // #169 PR 3: the unbound copies of a bound line come back as any book; a bound one only defective.
    it('does not take back a bound copy as an ordinary return; an unbound copy or line still returns', async () => {
      const sale = await sell([posItem(2, { serviceId: cloth, quantity: 1 }), posItem(1)], { amount: price * 3 + 100 });
      const [bound, plain] = sale.body.lineItems;
      const refused = await as(api().post('/api/v1/returns')).send({
        transactionId: Number(sale.body.id), lines: [{ transactionLineItemId: Number(bound.id), quantity: 2 }], reason: 'Not wanted',
      });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('BOUND_COPY_RETURN');
      const ok = await as(api().post('/api/v1/returns')).send({
        transactionId: Number(sale.body.id),
        lines: [{ transactionLineItemId: Number(plain.id), quantity: 1 }, { transactionLineItemId: Number(bound.id), quantity: 1 }],
        reason: 'Not wanted',
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    });
  });

  describe('an order with binding (4a, 5a)', () => {
    it('keeps the service on the draft without a job, and opens the job at confirmation', async () => {
      const draft = await newOrder([{ bookId, quantity: 2, service: { serviceId: leather, quantity: 2 } }], { confirm: false });
      expect(draft).toMatchObject({ total: price * 2 + 560 });
      expect(draft.lineItems[0].service).toMatchObject({ serviceId: leather, quantity: 2, unitFee: 280, lineTotal: 560, job: null });
      const confirmed = await as(api().post(`/api/v1/orders/${draft.id}/confirm`), sales).send({ paymentMethod: 'cash' });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.lineItems[0].service.job).toMatchObject({ status: 'REQUESTED', customerId });
      const paid = await one(`SELECT SUM(amount)::numeric AS paid FROM order_payments WHERE order_id = $1`, [draft.id]);
      expect(Number(paid.paid)).toBe(price * 2 + 560);
    });

    it('delivers only once the jobs are ready, and hands the bound copies over (job Collected)', async () => {
      const order = await newOrder([{ bookId, quantity: 1, service: { serviceId: cloth, quantity: 1 } }]);
      const job = order.lineItems[0].service.job.id as number;
      expect(order.allowedActions).not.toContain('fulfill');
      const listed = (await as(api().get(`/api/v1/orders?orderNumber=${order.orderNumber}`))).body.items[0];
      expect(listed.allowedActions).not.toContain('fulfill');
      const early = await as(api().post(`/api/v1/orders/${order.id}/fulfill`));
      expect(early.status).toBe(422);
      expect(early.body.error).toBe('SERVICE_JOBS_OPEN');
      await step(job, 'send');
      await step(job, 'ready');
      expect((await as(api().get(`/api/v1/orders/${order.id}`))).body.allowedActions).toContain('fulfill');
      const delivered = await as(api().post(`/api/v1/orders/${order.id}/fulfill`));
      expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
      expect(delivered.body.lineItems[0].service.job.status).toBe('COLLECTED');
    });

    it('cancels an order whose job is still Requested: book and fee back, the job cancelled; refused once at the binder', async () => {
      const order = await newOrder([{ bookId, quantity: 1, service: { serviceId: cloth, quantity: 1 } }]);
      const cancelled = await as(api().post(`/api/v1/orders/${order.id}/cancel`)).send({ reason: 'Changed mind', refundTo: 'original' });
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
      expect(cancelled.body.lineItems[0].service.job.status).toBe('CANCELLED');
      const refunded = await one(`SELECT COALESCE(SUM(refund_amount), 0)::numeric AS r FROM order_refunds WHERE order_id = $1`, [order.id]);
      expect(Number(refunded.r)).toBe(price + 100);

      const sent = await newOrder([{ bookId, quantity: 1, service: { serviceId: cloth, quantity: 1 } }]);
      await step(sent.lineItems[0].service.job.id, 'send');
      const refused = await as(api().post(`/api/v1/orders/${sent.id}/cancel`)).send({ reason: 'Changed mind', refundTo: 'original' });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('SERVICE_JOB_IN_PROGRESS');
    });
  });

  describe('the sales report (6a)', () => {
    it('counts fees as service income in net sales and gross profit, and agrees with the sale totals and its own lines', async () => {
      const report = (await as(api().get('/api/v1/reports/sales'))).body.summary;
      const detail = (await as(api().get('/api/v1/reports/sales/detail'))).body;
      const books = await one(
        `SELECT
           (SELECT COALESCE(SUM(li.line_total), 0) FROM transaction_line_items li JOIN transactions t ON t.id = li.transaction_id
              WHERE t.branch_id = $1 AND t.status <> 'voided') +
           (SELECT COALESCE(SUM(oli.total_price), 0) FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
              WHERE o.branch_id = $1 AND o.status NOT IN ('DRAFT', 'CANCELLED')) AS books,
           (SELECT COALESCE(SUM(sl.line_total), 0) FROM sale_service_lines sl
              LEFT JOIN transaction_line_items li ON li.id = sl.transaction_line_item_id LEFT JOIN transactions t ON t.id = li.transaction_id
              LEFT JOIN order_line_items oli ON oli.id = sl.order_line_item_id LEFT JOIN orders o ON o.id = oli.order_id
              WHERE (t.branch_id = $1 AND t.status <> 'voided') OR (o.branch_id = $1 AND o.status NOT IN ('DRAFT', 'CANCELLED'))) AS fees,
           (SELECT COALESCE(SUM(sl.standard_cost * sl.quantity), 0) FROM sale_service_lines sl
              LEFT JOIN transaction_line_items li ON li.id = sl.transaction_line_item_id LEFT JOIN transactions t ON t.id = li.transaction_id
              LEFT JOIN order_line_items oli ON oli.id = sl.order_line_item_id LEFT JOIN orders o ON o.id = oli.order_id
              WHERE (t.branch_id = $1 AND t.status <> 'voided') OR (o.branch_id = $1 AND o.status NOT IN ('DRAFT', 'CANCELLED'))) AS service_cost`,
        [branchId],
      );
      const fees = Number(books.fees);
      expect(fees).toBeGreaterThan(0);
      expect(report.serviceIncome).toBe(fees);
      expect(report.bookSales).toBe(Number(books.books));
      // Net sales = the sale totals less what came back (one plain copy was returned above).
      expect(report.netSales).toBe(Number((report.totalSales + report.totalPosSales - report.returnsValue).toFixed(2)));
      const serviceRows = detail.rows.filter((r: { kind: string }) => r.kind === 'SERVICE');
      expect(serviceRows.length).toBeGreaterThan(0);
      expect(serviceRows[0].book).toContain('binding');
      const sum = (rows: Array<{ netSalesAmount: number }>) => Number(rows.reduce((s, r) => s + r.netSalesAmount, 0).toFixed(2));
      expect(sum(serviceRows)).toBe(fees);
      expect(Number(serviceRows.reduce((s: number, r: { costAmount: number }) => s + r.costAmount, 0).toFixed(2))).toBe(Number(books.service_cost));
      expect(detail.totals.netSalesAmount).toBe(report.netSales);
      expect(detail.totals.grossProfit).toBe(report.grossProfit);
    });
  });
});
