import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff, setBranchPrice } from './helpers/seed.js';
import { db } from '../db/index.js';
import { getReceivablesExportRows } from '../modules/reports/reports.service.js';

// Receivables after the move to the layered structure (#21). Each test names
// what the endpoint did before.

const STAFF_PREFIX = 'recvrule_test_';
const BRANCH_PREFIX = 'Recv Rule ';
const CUSTOMER_CODE = 'RECVRULE-001';

describe('Receivables', () => {
  let branchId: number;
  let otherBranchId: number;
  let locationId: number;
  let customerId: number;
  let sales: string;
  let manager: string;
  let globalAdmin: string;
  let book: { id: number; price: number };
  let book2: { id: number; price: number };
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = manager) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));

  async function receivableOf(sourceType: string, sourceId: number | string): Promise<string> {
    const { rows } = await db.query(`SELECT id FROM receivables WHERE source_type = $1 AND source_entity_id = $2`, [sourceType, sourceId]);
    expect(rows).toHaveLength(1);
    return String(rows[0].id);
  }

  async function stock(bookId: number) {
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 50, 5, 0)
       ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = 50`,
      [bookId, locationId],
    );
  }

  /** A Customer_Pays exchange: the customer owes 100. */
  async function exchangeDebt(): Promise<{ id: string; owed: number }> {
    // Outgoing books are priced from the catalog; trade-ins are worth at most their price.
    await setBranchPrice(book.id, branchId, 50);
    await setBranchPrice(book2.id, branchId, 150);
    const res = await as(api().post('/api/v1/exchanges'), sales).send({
      locationId,
      customerId,
      incomingItems: [{ bookId: book.id, quantity: 1, unitPrice: 50 }],
      outgoingItems: [{ bookId: book2.id, quantity: 1 }],
      allowCredit: true,
    });
    expect(res.status).toBe(201);
    return { id: await receivableOf('exchange_difference', res.body.id), owed: Number(res.body.netBalance) };
  }

  async function orderDebt(): Promise<{ id: string; orderId: number; total: number }> {
    const created = await as(api().post('/api/v1/orders'), sales).send({
      locationId, saleType: 'credit_sale', customerId, items: [{ bookId: book.id, quantity: 1 }],
    });
    expect(created.status).toBe(201);
    const confirmed = await as(api().post(`/api/v1/orders/${created.body.id}/confirm`)).send({ dueDate: '2099-12-31' });
    expect(confirmed.status).toBe(200);
    return { id: await receivableOf('order_credit_sale', created.body.id), orderId: Number(created.body.id), total: Number(created.body.total) };
  }

  async function posDebt(): Promise<{ id: string; txId: string; total: number }> {
    const res = await as(api().post('/api/v1/pos/transactions'), sales).send({
      branchId, locationId, customerId, items: [{ bookId: book.id, quantity: 1 }], payments: [], allowCredit: true,
    });
    expect(res.status).toBe(201);
    return { id: await receivableOf('pos_credit_sale', res.body.id), txId: String(res.body.id), total: Number(res.body.grandTotal) };
  }

  const writeOff = (id: string, body: Record<string, unknown> = { reason: 'Customer cannot be traced' }, token = manager) =>
    as(api().post(`/api/v1/receivables/${id}/write-off`), token).send(body);
  const collect = (id: string, body: Record<string, unknown>) => as(api().post(`/api/v1/receivables/${id}/collect`)).send(body);
  const dueDate = (id: string, value: string | null, token = manager) =>
    as(api().patch(`/api/v1/receivables/${id}/due-date`), token).send({ dueDate: value });
  const makeOverdue = (id: string) =>
    db.query(`UPDATE receivables SET due_date = CURRENT_DATE - 3, status = 'Overdue' WHERE id = $1`, [id]);
  // Unpaid Orders mixes order, POS sale and receivable ids, which can be equal.
  const unpaidRows = async (): Promise<string[]> =>
    (await as(api().get(`/api/v1/payments/unpaid-orders?pageSize=100&branchId=${branchId}`))).body.items.map(
      (o: { id: string; sourceType: string }) => `${o.sourceType}:${o.id}`,
    );
  const dbToday = async (offsetDays: number): Promise<string> =>
    (await db.query(`SELECT TO_CHAR(CURRENT_DATE + $1::int, 'YYYY-MM-DD') AS d`, [offsetDays])).rows[0].d;

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    for (const sql of [
      `DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE branch_id IN (${branches}))`,
      `DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchange_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchange_outgoing_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchange_settlement_entries WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM financial_transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM exchanges WHERE branch_id IN (${branches})`,
      `DELETE FROM orders WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM store_credit_history WHERE customer_id IN (SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}')`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}')`,
      `DELETE FROM loyalty_history WHERE customer_id IN (SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}')`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}')`,
    ]) {
      await db.query(sql).catch(() => undefined);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    await db.query(`DELETE FROM customers WHERE customer_code = $1`, [CUSTOMER_CODE]).catch(() => undefined);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    otherBranchId = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    const g = await createTestStaff({ username: `${STAFF_PREFIX}global`, role: 'Admin', branchId });
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [g.staffId]);
    globalAdmin = g.token;

    const loc = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
    locationId = loc.rows.length
      ? loc.rows[0].id
      : (await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Recv Rule Loc', true) RETURNING id`, [branchId])).rows[0].id;
    const books = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL ORDER BY id LIMIT 2`);
    book = { id: books.rows[0].id, price: Number(books.rows[0].default_price) };
    book2 = { id: books.rows[1].id, price: Number(books.rows[1].default_price) };
    await stock(book.id);
    await stock(book2.id);
    customerId = (await db.query(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Recv Rule Customer', $1, true) RETURNING id`,
      [CUSTOMER_CODE],
    )).rows[0].id;
  });

  afterAll(cleanUp);

  describe('write-off', () => {
    it('needs a reason (was: 200 without one)', async () => {
      const { id } = await exchangeDebt();
      for (const body of [{}, { reason: '   ' }]) {
        const res = await writeOff(id, body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('VALIDATION_ERROR');
      }
    });

    it('is its own status, with the amount, reason, ledger entry and audit entry (was: Settled, nothing recorded)', async () => {
      const { id, owed } = await exchangeDebt();
      const res = await writeOff(id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'WrittenOff',
        outstandingAmount: 0,
        writtenOffAmount: owed,
        writeOffReason: 'Customer cannot be traced',
        settlementDate: null,
      });

      const ledger = await db.query(`SELECT type, amount, receivable_id FROM financial_transactions WHERE receivable_id = $1`, [id]);
      expect(ledger.rows.map((r) => [r.type, Number(r.amount)])).toEqual([['write_off', owed]]);
      const audit = await db.query(
        `SELECT meta FROM audit_logs WHERE entity_type = 'receivable' AND entity_id = $1 AND action = 'WRITE_OFF'`,
        [id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].meta).toMatchObject({ amount: owed, reason: 'Customer cannot be traced' });
    });

    it('takes a POS sale out of Unpaid Orders and refuses payment on it (was: still collectable)', async () => {
      const { id, txId, total } = await posDebt();
      expect(await unpaidRows()).toContain(`pos:${txId}`);
      expect((await writeOff(id)).status).toBe(200);
      expect(await unpaidRows()).not.toContain(`pos:${txId}`);

      const res = await as(api().post(`/api/v1/pos/transactions/${txId}/payment`)).send({ payments: [{ method: 'cash', amount: total }] });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('RECEIVABLE_WRITTEN_OFF');
      const paid = await db.query(`SELECT COUNT(*)::int AS n FROM transaction_payments WHERE transaction_id = $1`, [txId]);
      expect(paid.rows[0].n).toBe(0);
    });

    it('takes a credit order out of Unpaid Orders and refuses payment on it (was: still collectable)', async () => {
      const { id, orderId, total } = await orderDebt();
      expect(await unpaidRows()).toContain(`order:${orderId}`);
      expect((await writeOff(id)).status).toBe(200);
      expect(await unpaidRows()).not.toContain(`order:${orderId}`);

      for (const res of [
        await collect(id, { amount: total, paymentMethod: 'cash' }),
        await as(api().post('/api/v1/payments')).send({ orderId, amount: total, paymentMethod: 'cash' }),
      ]) {
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('RECEIVABLE_WRITTEN_OFF');
      }
      const paid = await db.query(`SELECT COUNT(*)::int AS n FROM order_payments WHERE order_id = $1`, [orderId]);
      expect(paid.rows[0].n).toBe(0);
    });

    it('is not reported as money collected (was: counted as collected)', async () => {
      const { id } = await exchangeDebt();
      await writeOff(id);
      const ref = (await db.query(`SELECT source_ref_id FROM receivables WHERE id = $1`, [id])).rows[0].source_ref_id;
      const row = (await getReceivablesExportRows({ branchId })).find((r) => r.order_reference === ref);
      expect(row?.collected_amount).toBe(0);
    });

    it('cancels a cancelled order\'s receivable, which is not reported as collected (was: Settled, counted as collected)', async () => {
      const { id, orderId } = await orderDebt();
      expect((await as(api().post(`/api/v1/orders/${orderId}/cancel`)).send({ reason: 'Customer changed mind' })).status).toBe(200);
      const rec = (await db.query(`SELECT status, source_ref_id FROM receivables WHERE id = $1`, [id])).rows[0];
      expect(rec.status).toBe('Cancelled');
      const row = (await getReceivablesExportRows({ branchId })).find((r) => r.order_reference === rec.source_ref_id);
      expect(row?.collected_amount).toBe(0);
    });

    it('answers 410 on the retired /settle (was: 200)', async () => {
      const { id } = await exchangeDebt();
      const res = await as(api().post(`/api/v1/receivables/${id}/settle`)).send({ notes: 'x' });
      expect(res.status).toBe(410);
      expect((await db.query(`SELECT status FROM receivables WHERE id = $1`, [id])).rows[0].status).toBe('Pending');
    });
  });

  describe('collecting on an exchange difference', () => {
    it('refuses an unknown payment method (was: 200, booked as that method)', async () => {
      const { id, owed } = await exchangeDebt();
      const res = await collect(id, { amount: owed, paymentMethod: 'cheque' });
      expect(res.status).toBe(400);
    });

    it('lets only one of two simultaneous full payments through (was: both, paid twice)', async () => {
      const { id, owed } = await exchangeDebt();
      const results = await Promise.all([
        collect(id, { amount: owed, paymentMethod: 'cash' }),
        collect(id, { amount: owed, paymentMethod: 'cash' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      const ledger = await db.query(`SELECT COUNT(*)::int AS n FROM financial_transactions WHERE receivable_id = $1 AND type = 'payment'`, [id]);
      expect(ledger.rows[0].n).toBe(1);
    });

    it('leaves a past-due debt Overdue after a part payment (was: PartiallyPaid until the nightly job)', async () => {
      const { id } = await exchangeDebt();
      await makeOverdue(id);
      const res = await collect(id, { amount: 10, paymentMethod: 'cash' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Overdue');
    });
  });

  describe('due date', () => {
    it('can be changed only by Admin, Manager or Finance_Officer (was: anyone who takes payments)', async () => {
      const { id } = await exchangeDebt();
      expect((await dueDate(id, '2099-01-31', sales)).status).toBe(403);
      expect((await dueDate(id, '2099-01-31')).status).toBe(200);
    });

    it('records the old and new date in the audit log', async () => {
      const { id } = await exchangeDebt();
      await dueDate(id, '2099-01-31');
      await dueDate(id, '2099-02-28');
      const audit = await db.query(
        `SELECT meta FROM audit_logs WHERE entity_type = 'receivable' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
        [id],
      );
      expect(audit.rows[0].meta).toMatchObject({ previousDueDate: '2099-01-31', dueDate: '2099-02-28' });
    });

    it('refuses a date that does not exist with 400 (was: 500)', async () => {
      const { id } = await exchangeDebt();
      const res = await dueDate(id, '2026-02-31');
      expect(res.status).toBe(400);
    });

    it('makes an overdue receivable current again when the date is removed (was: stayed Overdue)', async () => {
      const { id } = await exchangeDebt();
      await makeOverdue(id);
      const res = await dueDate(id, null);
      expect(res.body).toMatchObject({ dueDate: null, status: 'Pending' });
    });

    it('makes it Overdue at once when the new date has passed, by the database\'s calendar (was: Pending)', async () => {
      const { id } = await exchangeDebt();
      expect((await dueDate(id, await dbToday(-1))).body.status).toBe('Overdue');
      expect((await dueDate(id, await dbToday(0))).body.status).toBe('Pending');
    });
  });

  it('sums every branch for staff with access to all branches who name none (was: only their own branch)', async () => {
    await exchangeDebt();
    await db.query(
      `INSERT INTO receivables (source_type, source_ref_id, source_entity_id, customer_id, branch_id, original_amount, outstanding_amount)
       VALUES ('pos_credit_sale', 'RECVRULE-OTHER', 2000000000, $1, $2, 70, 70)`,
      [customerId, otherBranchId],
    );
    const res = await as(api().get('/api/v1/receivables/summary'), globalAdmin);
    const expected = await db.query(
      `SELECT COALESCE(SUM(outstanding_amount), 0) AS total FROM receivables WHERE status IN ('Pending', 'PartiallyPaid', 'Overdue')`,
    );
    expect(res.status).toBe(200);
    expect(res.body.totalOutstanding).toBeCloseTo(Number(expected.rows[0].total), 2);
    const own = await as(api().get(`/api/v1/receivables/summary?branchId=${branchId}`), globalAdmin);
    expect(res.body.totalOutstanding).toBeGreaterThan(own.body.totalOutstanding);
  });
});
