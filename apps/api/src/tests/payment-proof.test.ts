/**
 * payment-proof.test.ts
 *
 * Bank and Telebirr payments carry their proof (owner decisions 1a, 2a, 3a,
 * 2026-10-18): a bank transfer names the bank the customer paid from and the
 * transfer's reference, a Telebirr payment its transaction number, in every
 * flow that takes customer money. The bank is kept in its own field (1a),
 * both are required (2a), everywhere (3a). Each test names what happened
 * before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches, cleanBankAccounts } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

process.env.FEATURE_BANK_ACCOUNTS = 'true';

const STAFF_PREFIX = 'payproof_test_';
const BRANCH_PREFIX = 'Pay Proof ';
const CUSTOMER_CODE = 'PAYPROOF-001';

describe('Bank and Telebirr payments carry their proof', () => {
  let branchId: number;
  let locationId: number;
  let customerId: number;
  let bookA: number;
  let bookB: number;
  let priceB: number;
  let sales: string;
  let manager: string;
  let account: number;
  let accountNumber = 8_100_000;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = sales) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const count = async (table: string) => Number((await one(`SELECT COUNT(*)::int AS n FROM ${table}`)).n);
  const messages = (res: request.Response): string[] =>
    (res.body.details?.issues ?? []).map((i: { message: string }) => i.message);

  const sell = (payments: object[], extra: object = {}) =>
    as(api().post('/api/v1/pos/transactions')).send({ locationId, items: [{ bookId: bookB, quantity: 1 }], payments, ...extra });
  const creditSale = async () => {
    const res = await sell([], { customerId, allowCredit: true });
    expect(res.status).toBe(201);
    return res.body as { id: string; grandTotal: number };
  };
  const order = async (saleType: 'cash_sale' | 'credit_sale') => {
    const res = await as(api().post('/api/v1/orders')).send({ locationId, saleType, customerId, items: [{ bookId: bookB, quantity: 1 }] });
    expect(res.status).toBe(201);
    return res.body as { id: string; total: number };
  };
  const confirm = (id: string, body: object) => as(api().post(`/api/v1/orders/${id}/confirm`)).send(body);
  const exchange = (body: object) =>
    as(api().post('/api/v1/exchanges')).send({
      locationId,
      customerId,
      incomingItems: [{ bookId: bookA, quantity: 1, unitPrice: 1 }],
      outgoingItems: [{ bookId: bookB, quantity: 1 }],
      ...body,
    });
  const receivableOf = async (sourceType: string, entityId: string) =>
    String((await one(`SELECT id FROM receivables WHERE source_type = $1 AND source_entity_id = $2`, [sourceType, entityId])).id);
  const collect = (receivableId: string, body: object) => as(api().post(`/api/v1/receivables/${receivableId}/collect`)).send(body);
  const movementsOf = async (sourceType: string) =>
    (await db.query(`SELECT source_id::text, notes FROM bank_reconciliation WHERE bank_account_id = $1 AND source_type = $2 ORDER BY id`, [account, sourceType])).rows;

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    const customer = `SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`;
    for (const b of (await db.query(branches)).rows) await cleanBankAccounts(b.id);
    for (const statement of [
      `DELETE FROM order_payments WHERE order_id IN (${orders})`,
      `DELETE FROM financial_transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${orders})`,
      `DELETE FROM order_line_items WHERE order_id IN (${orders})`,
      `DELETE FROM orders WHERE id IN (${orders})`,
      `DELETE FROM exchange_settlement_entries WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchange_incoming_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchange_outgoing_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchanges WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
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

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    locationId = (await one(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Pay Proof Loc', true) RETURNING id`,
      [branchId],
    )).id;
    const books = (await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 2`)).rows;
    bookA = books[0].id;
    bookB = books[1].id;
    priceB = Number(books[1].default_price);
    for (const bookId of [bookA, bookB]) {
      await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 500, 5, 0)`, [bookId, locationId]);
    }
    customerId = (await one(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Pay Proof Customer', $1, true) RETURNING id`,
      [CUSTOMER_CODE],
    )).id;
    account = (await as(api().post(`/api/v1/branches/${branchId}/bank-accounts`), manager).send({
      accountName: 'Pay Proof', bankName: 'CBE', accountNumber: String(accountNumber++),
    })).body.id;
  });

  afterAll(cleanUp);

  describe('the rule (decisions 2a and 3a)', () => {
    it('refuses a bank payment without the bank or the reference, in every flow (was: recorded with neither)', async () => {
      const before = await count('transaction_payments');
      const pos = await sell([{ method: 'bank', amount: priceB, bankAccountId: account }]);
      expect(pos.status).toBe(400);
      expect(messages(pos)).toEqual(['Enter the bank the customer paid from', 'Enter the bank transfer reference']);
      expect(await count('transaction_payments')).toBe(before);

      const credit = await order('credit_sale');
      await confirm(credit.id, { dueDate: '2099-12-31' });
      const payment = await as(api().post('/api/v1/payments')).send({
        orderId: Number(credit.id), amount: 1, paymentMethod: 'bank', transactionReference: 'FT-1', bankAccountId: account,
      });
      expect(messages(payment)).toEqual(['Enter the bank the customer paid from']);

      const cash = await order('cash_sale');
      const confirmed = await confirm(cash.id, { paymentMethod: 'bank', payerBank: 'CBE', bankAccountId: account });
      expect(messages(confirmed)).toEqual(['Enter the bank transfer reference']);
      expect((await one(`SELECT status FROM orders WHERE id = $1`, [cash.id])).status).toBe('DRAFT');

      const ex = await exchange({ payments: [{ method: 'bank', amount: priceB - 1, reference: 'FT-2', bankAccountId: account }] });
      expect(messages(ex)).toEqual(['Enter the bank the customer paid from']);
    });

    it('refuses a Telebirr payment without its transaction number, in every flow (was: recorded without one)', async () => {
      expect(messages(await sell([{ method: 'mobile', amount: priceB }]))).toEqual(['Enter the Telebirr transaction number']);
      expect(messages(await sell([{ method: 'mobile', amount: priceB, reference: '   ' }]))).toEqual(['Enter the Telebirr transaction number']);
      const cash = await order('cash_sale');
      expect(messages(await confirm(cash.id, { paymentMethod: 'mobile' }))).toEqual(['Enter the Telebirr transaction number']);
      expect(messages(await exchange({ payments: [{ method: 'mobile', amount: priceB - 1 }] }))).toEqual(['Enter the Telebirr transaction number']);
      const sale = await creditSale();
      const receivable = await receivableOf('pos_credit_sale', sale.id);
      expect(messages(await collect(receivable, { amount: 1, paymentMethod: 'mobile' }))).toEqual(['Enter the Telebirr transaction number']);
    });

    it("refuses a customer's bank on a payment that is not by bank", async () => {
      const res = await sell([{ method: 'cash', amount: priceB, payerBank: 'CBE' }]);
      expect(messages(res)).toEqual(["Only a bank payment names the customer's bank"]);
    });
  });

  describe('kept with the payment (decision 1a)', () => {
    it('keeps the bank and the reference of a POS payment, trimmed, and notes them on the bank movement', async () => {
      const res = await sell([{ method: 'bank', amount: priceB, payerBank: '  Awash Bank ', reference: ' FT24001 ', bankAccountId: account }]);
      expect(res.status).toBe(201);
      expect(res.body.payments[0]).toMatchObject({ method: 'bank', payerBank: 'Awash Bank', reference: 'FT24001', bankAccountId: account });
      const [movement] = (await movementsOf('pos_payment')).filter((m) => m.source_id === res.body.payments[0].id);
      expect(movement.notes).toBe(`Sale ${res.body.transactionNumber} · Awash Bank · FT24001`);

      const telebirr = await sell([{ method: 'mobile', amount: priceB, reference: 'TB-77' }]);
      expect(telebirr.body.payments[0]).toMatchObject({ method: 'mobile', payerBank: null, reference: 'TB-77' });
    });

    it('keeps the bank and the reference of an order payment', async () => {
      const credit = await order('credit_sale');
      await confirm(credit.id, { dueDate: '2099-12-31' });
      const res = await as(api().post('/api/v1/payments')).send({
        orderId: Number(credit.id), amount: 1, paymentMethod: 'bank', payerBank: 'Dashen Bank', transactionReference: 'FT-ORD-1', bankAccountId: account,
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ payerBank: 'Dashen Bank', transactionReference: 'FT-ORD-1' });
      const [movement] = (await movementsOf('order_payment')).filter((m) => m.source_id === res.body.id);
      expect(movement.notes).toBe(`Payment ${res.body.paymentReference} · Dashen Bank · FT-ORD-1`);
    });

    it("keeps an exchange payment's reference and bank and returns them (was: the reference went to a note nothing read)", async () => {
      const res = await exchange({ payments: [{ method: 'bank', amount: priceB - 1, payerBank: 'Zemen Bank', reference: 'FT-EXC-1', bankAccountId: account }] });
      expect(res.status).toBe(201);
      const read = await as(api().get(`/api/v1/exchanges/${res.body.id}`));
      expect(read.body.settlementEntries).toEqual([
        expect.objectContaining({ entryType: 'cash_payment', method: 'bank', reference: 'FT-EXC-1', payerBank: 'Zemen Bank' }),
      ]);
    });
  });

  describe('order confirmation by bank', () => {
    it('needs an account of the branch and queues the payment for reconciliation (was: no account, no movement)', async () => {
      const cash = await order('cash_sale');
      const proof = { paymentMethod: 'bank', payerBank: 'CBE', transactionReference: 'FT-CONF-1' };
      const noAccount = await confirm(cash.id, proof);
      expect(noAccount.status).toBe(400);
      expect(noAccount.body.message).toBe('bankAccountId is required for bank payments');

      const res = await confirm(cash.id, { ...proof, bankAccountId: account });
      expect(res.status).toBe(200);
      const payment = await one(
        `SELECT id::text, payment_reference, payer_bank, transaction_reference, bank_account_id FROM order_payments WHERE order_id = $1`,
        [cash.id],
      );
      expect(payment).toMatchObject({ payer_bank: 'CBE', transaction_reference: 'FT-CONF-1', bank_account_id: account });
      const [movement] = (await movementsOf('order_payment')).filter((m) => m.source_id === payment.id);
      expect(movement.notes).toBe(`Payment ${payment.payment_reference} · CBE · FT-CONF-1`);
    });

    it('keeps the Telebirr number of a cash order paid by Telebirr', async () => {
      const cash = await order('cash_sale');
      expect((await confirm(cash.id, { paymentMethod: 'mobile', transactionReference: 'TB-CONF-1' })).status).toBe(200);
      expect(await one(`SELECT payer_bank, transaction_reference FROM order_payments WHERE order_id = $1`, [cash.id]))
        .toEqual({ payer_bank: null, transaction_reference: 'TB-CONF-1' });
    });
  });

  describe('collecting through Receivables', () => {
    it("collects a POS credit sale by bank on the branch's account with its reference (was: no account, the note saved as the reference)", async () => {
      const sale = await creditSale();
      const receivable = await receivableOf('pos_credit_sale', sale.id);
      const res = await collect(receivable, {
        amount: 1, paymentMethod: 'bank', payerBank: 'Hibret Bank', transactionReference: 'FT-RCV-1', bankAccountId: account, notes: 'Paid by the customer\'s office',
      });
      expect(res.status).toBe(200);
      const payment = await one(`SELECT id::text, reference, payer_bank, bank_account_id FROM transaction_payments WHERE transaction_id = $1`, [sale.id]);
      expect(payment).toMatchObject({ reference: 'FT-RCV-1', payer_bank: 'Hibret Bank', bank_account_id: account });
      expect((await movementsOf('pos_payment')).some((m) => m.source_id === payment.id)).toBe(true);
    });

    it("keeps an exchange difference's Telebirr number, shown in payment history (was: no reference kept)", async () => {
      const ex = await exchange({ allowCredit: true });
      expect(ex.status).toBe(201);
      const receivable = await receivableOf('exchange_difference', ex.body.id);
      expect((await collect(receivable, { amount: 1, paymentMethod: 'mobile', transactionReference: 'TB-EXC-9' })).status).toBe(200);

      const history = await as(api().get('/api/v1/payments?pageSize=100'));
      expect(history.body.items).toContainEqual(expect.objectContaining({
        sourceType: 'exchange', paymentMethod: 'mobile', transactionReference: 'TB-EXC-9', payerBank: null,
      }));
    });

    it("numbers a POS collection in payment history by the shop, not by the customer's reference (was: the bank's reference shown as the receipt number)", async () => {
      const sale = await creditSale();
      const receivable = await receivableOf('pos_credit_sale', sale.id);
      await collect(receivable, { amount: 1, paymentMethod: 'mobile', transactionReference: 'TB-POS-5' });
      const history = await as(api().get('/api/v1/payments?pageSize=100'));
      const row = history.body.items.find((p: { orderId: string }) => p.orderId === sale.id);
      expect(row).toMatchObject({ transactionReference: 'TB-POS-5', paymentReference: expect.stringMatching(/^PAY-POS-\d+$/) });
    });
  });

  describe('payments ledger report', () => {
    it("lists the customer's bank and the reference, in the report and its export", async () => {
      const ledger = await as(api().get('/api/v1/reports/payments-ledger'), manager);
      expect(ledger.status).toBe(200);
      expect(ledger.body.rows).toContainEqual(expect.objectContaining({ referenceType: 'POS', payerBank: 'Awash Bank', paymentReference: 'FT24001' }));
      expect(ledger.body.rows).toContainEqual(expect.objectContaining({ referenceType: 'ORDER', payerBank: 'CBE', paymentReference: 'FT-CONF-1' }));
      expect(ledger.body.rows).toContainEqual(expect.objectContaining({ referenceType: 'EXCHANGE', payerBank: 'Zemen Bank', paymentReference: 'FT-EXC-1' }));

      const csv = await as(api().get('/api/v1/reports/payments-ledger/export'), manager);
      expect(csv.text.split('\n')[0]).toContain('Payment Method,Customer Bank,Payment Reference,Amount');
      expect(csv.text).toContain('Awash Bank,FT24001');
    });
  });
});
