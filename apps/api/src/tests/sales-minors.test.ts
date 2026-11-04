// #240 (#225 P9, P11, R1, B2; owner decision 3a, 2026-11-04). A voided sale
// owes nothing (was: its due amount and date still shown). Voiding a sale and
// returning books each ask why, and the audit log keeps it (was: no reason).
// A binding needs a customer with a phone: they are called when it is ready
// (was: taken for a customer nobody could call).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'salesminor_';
const BRANCH_PREFIX = 'Sales Minors ';
const CODE = 'SALESMINOR';

describe('Sales minors (#240)', () => {
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let price: number;
  let withPhone: number;
  let noPhone: number;
  let binding: number;
  const t: Record<string, string> = {};
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const as = (token: string) => ({
    get: (path: string) => request(getTestApp()).get(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId)),
    post: (path: string, body: object = {}) =>
      request(getTestApp()).post(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId)).send(body),
  });
  const ok = async (res: request.Response, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body; };
  const sell = async (body: object) =>
    ok(await as(t.sales).post('/api/v1/pos/transactions', { locationId, items: [{ bookId, quantity: 1 }], ...body }), 201);
  const auditOf = async (entityType: string, id: string) =>
    (await db.query(`SELECT meta FROM audit_logs WHERE entity_type = $1 AND entity_id = $2 ORDER BY id`, [entityType, id])).rows.map((r) => r.meta);

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const tx = `SELECT id FROM transactions WHERE branch_id IN (${branches})`;
    const customers = `SELECT id FROM customers WHERE full_name LIKE '${CODE}%'`;
    for (const statement of [
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM service_jobs WHERE branch_id IN (${branches})`,
      `DELETE FROM sale_service_lines WHERE transaction_line_item_id IN (SELECT id FROM transaction_line_items WHERE transaction_id IN (${tx}))`,
      `DELETE FROM cash_session_movements WHERE session_id IN (SELECT id FROM cash_sessions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transaction_payments WHERE transaction_id IN (${tx})`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (${tx})`,
      `DELETE FROM financial_transactions WHERE receivable_id IN (SELECT id FROM receivables WHERE branch_id IN (${branches}))`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM branch_service_fees WHERE service_id IN (SELECT id FROM services WHERE code = '${CODE}')`,
      `DELETE FROM services WHERE code = '${CODE}'`,
      `DELETE FROM loyalty_transactions WHERE customer_id IN (${customers})`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (${customers})`,
      `DELETE FROM store_credit_history WHERE customer_id IN (${customers})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customers})`,
      `DELETE FROM customers WHERE id IN (${customers})`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => { if (err.code !== '42P01' && err.code !== '42703') throw err; });
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    locationId = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Minors shelf', true) RETURNING id`, [branchId])).id;
    for (const [name, role] of [['sales', 'Sales'], ['manager', 'Manager'], ['admin', 'Admin']] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId })).token;
    }
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 50, 4)`, [bookId, locationId]);
    withPhone = (await ok(await as(t.sales).post('/api/v1/customers', { fullName: `${CODE} Called`, phone: '+251911240240' }), 201)).id;
    noPhone = (await ok(await as(t.sales).post('/api/v1/customers', { fullName: `${CODE} Unreachable` }), 201)).id;
    const formatId = (await one(`SELECT id FROM book_formats ORDER BY id LIMIT 1`)).id;
    binding = (await ok(await as(t.admin).post('/api/v1/services', {
      code: CODE, name: 'Minors binding', formatId, fee: 50, standardCost: 20, discountable: false, turnaroundDays: 3,
    }), 201)).id;
  });

  afterAll(cleanUp);

  describe('voiding a sale (P9, P11)', () => {
    it('asks why, and the audit log keeps it (was: no reason)', async () => {
      const sale = await sell({ payments: [{ method: 'mobile', amount: price, reference: 'TB-P11' }] });
      const refused = await as(t.manager).post(`/api/v1/pos/transactions/${sale.id}/void`);
      expect([refused.status, refused.body.error]).toEqual([400, 'VALIDATION_ERROR']);
      await ok(await as(t.manager).post(`/api/v1/pos/transactions/${sale.id}/void`, { reason: 'Rang up the wrong book' }));
      expect(await auditOf('transaction', sale.id)).toContainEqual(expect.objectContaining({ action: 'void', reason: 'Rang up the wrong book' }));
    });

    it('leaves a voided credit sale owing nothing (was: its due amount and date)', async () => {
      const sale = await sell({ customerId: withPhone, allowCredit: true, payments: [{ method: 'cash', amount: 1 }] });
      expect(sale.amountDue).toBeGreaterThan(0);
      const voided = await ok(await as(t.manager).post(`/api/v1/pos/transactions/${sale.id}/void`, { reason: 'Customer changed their mind' }));
      expect(voided).toMatchObject({ status: 'voided', amountDue: 0, dueDate: null });
      const listed = (await ok(await as(t.sales).get(`/api/v1/pos/transactions?transactionNumber=${sale.transactionNumber}`))).items[0];
      expect(listed).toMatchObject({ amountDue: 0, dueDate: null });
    });
  });

  it('asks why books come back (R1; was: optional, left empty)', async () => {
    const sale = await sell({ payments: [{ method: 'mobile', amount: price, reference: 'TB-R1' }] });
    const line = (await ok(await as(t.sales).get(`/api/v1/pos/transactions/${sale.id}`))).lineItems[0];
    const body = { transactionId: Number(sale.id), lines: [{ transactionLineItemId: Number(line.id), quantity: 1 }] };
    const refused = await as(t.sales).post('/api/v1/returns', body);
    expect([refused.status, refused.body.error]).toEqual([400, 'VALIDATION_ERROR']);
    const done = await ok(await as(t.sales).post('/api/v1/returns', { ...body, reason: 'Duplicate gift' }), 201);
    expect(done.reason).toBe('Duplicate gift');
  });

  describe('a binding (B2)', () => {
    const withBinding = (customerId: number) => ({
      customerId, items: [{ bookId, quantity: 1, service: { serviceId: binding, quantity: 1 } }],
      payments: [{ method: 'mobile', amount: price + 50, reference: 'TB-B2' }],
    });

    it('is refused for a customer with no phone to call (was: taken)', async () => {
      const res = await as(t.sales).post('/api/v1/pos/transactions', { locationId, ...withBinding(noPhone) });
      expect([res.status, res.body.error]).toEqual([422, 'SERVICE_REQUIRES_PHONE']);
    });

    it('is taken for a customer with a phone', async () => {
      await sell(withBinding(withPhone));
    });
  });
});
