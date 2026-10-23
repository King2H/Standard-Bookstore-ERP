import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  ApAgingSchema, ExchangeDetailResponseSchema, ExchangeReportSchema, OpenPurchaseOrdersSchema, PaymentReportSchema,
  PaymentsLedgerSchema, PurchasesByBookSchema, PurchasesBySupplierSchema, ReturnReportResponseSchema,
  SupplierBalancesSchema, SupplierPaymentHistorySchema, TopReturnedBooksSchema,
} from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #22, part 3: the payment, exchange, return and procurement reports on the
// layered structure. The payment report counts all customer money, each
// dated when it moved (owner decision a): order, POS and exchange payments
// and collections in; order, return and exchange refunds out. A voided sale
// or exchange handed its money back, so it is left out.

const STAFF_PREFIX = 'rptmoney_test_';
const BRANCH_PREFIX = 'Report Money ';
const REF = 'RPTMONEY-';

describe('Payment, exchange, return and procurement reports', () => {
  let branchId: number;
  let staffId: number;
  let token: string;
  let today: string;
  let poId: number;
  const api = () => request(getTestApp());
  const get = (path: string) => api().get(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));
  const insert = async (text: string, params: unknown[]): Promise<number> => Number((await db.query(text, params)).rows[0].id);

  async function exchange(reference: string, status: 'Completed' | 'Cancelled'): Promise<number> {
    const voided = status === 'Cancelled';
    return insert(
      `INSERT INTO exchanges (exchange_reference, branch_id, created_by, status, total_incoming_value, total_outgoing_value,
                              voided_at, voided_by, void_reason)
       VALUES ($1, $2, $3, $4, 100, 120, $5, $6, $7) RETURNING id`,
      [`${REF}${reference}`, branchId, staffId, status, voided ? new Date() : null, voided ? staffId : null, voided ? 'test void' : null],
    );
  }

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const pos = `SELECT id FROM purchase_orders WHERE branch_id IN (${branches})`;
    for (const statement of [
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM financial_transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM exchange_settlement_entries WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchanges WHERE branch_id IN (${branches})`,
      `DELETE FROM order_refunds WHERE order_id IN (SELECT id FROM orders WHERE branch_id IN (${branches}))`,
      `WITH refunds AS (DELETE FROM order_refunds WHERE payment_id IN (SELECT id FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id IN (${branches})))) DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id IN (${branches}))`,
      `DELETE FROM orders WHERE branch_id IN (${branches})`,
      `DELETE FROM supplier_payments WHERE po_id IN (${pos})`,
      `DELETE FROM po_receipts WHERE po_id IN (${pos})`,
      `DELETE FROM po_line_items WHERE po_id IN (${pos})`,
      `DELETE FROM purchase_orders WHERE id IN (${pos})`,
      `DELETE FROM suppliers WHERE name LIKE '${REF}%'`,
      `DELETE FROM locations WHERE branch_id IN (${branches})`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    today = (await db.query(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0].d;
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    const staff = await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId });
    staffId = staff.staffId;
    token = staff.token;
    const locationId = await insert(`INSERT INTO locations (branch_id, name) VALUES ($1, 'Report Money Loc') RETURNING id`, [branchId]);
    const bookId = Number((await db.query(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 1`)).rows[0].id);

    // An order: 100 cash and 50 mobile in, 30 refunded.
    const orderId = await insert(
      `INSERT INTO orders (order_number, branch_id, created_by, status, subtotal, total) VALUES ($1, $2, $3, 'CONFIRMED', 150, 150) RETURNING id`,
      [`${REF}O1`, branchId, staffId],
    );
    const cashPayment = await insert(
      `INSERT INTO order_payments (order_id, payment_reference, amount, payment_method, status, processed_by) VALUES ($1, $2, 100, 'cash', 'success', $3) RETURNING id`,
      [orderId, `${REF}OP1`, staffId],
    );
    await db.query(
      `INSERT INTO order_payments (order_id, payment_reference, amount, payment_method, status, processed_by) VALUES ($1, $2, 50, 'mobile', 'success', $3)`,
      [orderId, `${REF}OP2`, staffId],
    );
    await db.query(
      `INSERT INTO order_refunds (order_id, payment_id, refund_amount, reason, processed_by) VALUES ($1, $2, 30, 'test', $3)`,
      [orderId, cashPayment, staffId],
    );

    // A POS sale of 40 cash, 10 of it returned and refunded; a voided sale of 25.
    const sale = await insert(
      `INSERT INTO transactions (transaction_number, branch_id, location_id, staff_id, subtotal, grand_total, status)
       VALUES ($1, $2, $3, $4, 40, 40, 'completed') RETURNING id`,
      [`${REF}T1`, branchId, locationId, staffId],
    );
    await db.query(`INSERT INTO transaction_payments (transaction_id, method, amount) VALUES ($1, 'cash', 40)`, [sale]);
    const voided = await insert(
      `INSERT INTO transactions (transaction_number, branch_id, location_id, staff_id, subtotal, grand_total, status)
       VALUES ($1, $2, $3, $4, 25, 25, 'voided') RETURNING id`,
      [`${REF}T2`, branchId, locationId, staffId],
    );
    await db.query(`INSERT INTO transaction_payments (transaction_id, method, amount) VALUES ($1, 'cash', 25)`, [voided]);
    const returnId = await insert(
      `INSERT INTO returns (return_number, transaction_id, branch_id, processed_by, refund_method, total_refund_amount, status)
       VALUES ($1, $2, $3, $4, 'cash', 10, 'completed') RETURNING id`,
      [`${REF}R1`, sale, branchId, staffId],
    );
    await db.query(`INSERT INTO refunds (return_id, amount, method) VALUES ($1, 10, 'cash')`, [returnId]);

    // A completed exchange with 20 cash paid at the counter; a voided one
    // whose 70 was handed back; one whose difference owed was collected later (15).
    const paid = await exchange('E1', 'Completed');
    await db.query(`INSERT INTO exchange_settlement_entries (exchange_id, entry_type, amount, method) VALUES ($1, 'cash_payment', 20, 'cash')`, [paid]);
    const cancelled = await exchange('E2', 'Cancelled');
    await db.query(`INSERT INTO exchange_settlement_entries (exchange_id, entry_type, amount, method) VALUES ($1, 'cash_payment', 70, 'cash')`, [cancelled]);
    const owed = await exchange('E3', 'Completed');
    await db.query(
      `INSERT INTO financial_transactions (type, exchange_id, idempotency_key, amount, method, staff_id, branch_id)
       VALUES ('payment', $1, $2, 15, 'cash', $3, $4)`,
      [owed, `${REF}${owed}`, staffId, branchId],
    );

    // A PO: 4 of 10 received at 5 (20 owed), 8 paid, goods received 40 days ago.
    const supplierId = await insert(`INSERT INTO suppliers (name, contact_info) VALUES ($1, '{}') RETURNING id`, [`${REF}Supplier`]);
    poId = await insert(
      `INSERT INTO purchase_orders (supplier_id, branch_id, created_by, status, total_amount) VALUES ($1, $2, $3, 'partially_received', 50) RETURNING id`,
      [supplierId, branchId, staffId],
    );
    await db.query(`INSERT INTO po_line_items (po_id, book_id, quantity, received_quantity, unit_cost) VALUES ($1, $2, 10, 4, 5)`, [poId, bookId]);
    await db.query(
      `INSERT INTO po_receipts (po_id, location_id, received_by, received_at) VALUES ($1, $2, $3, now() - INTERVAL '40 days')`,
      [poId, locationId, staffId],
    );
    await db.query(
      `INSERT INTO supplier_payments (po_id, supplier_id, branch_id, amount, created_by) VALUES ($1, $2, $3, 8, $4)`,
      [poId, supplierId, branchId, staffId],
    );
  });

  afterAll(cleanUp);

  describe('the payment report counts all customer money', () => {
    it('takes in order, POS and exchange payments and collections; voided sales and exchanges left out (was: orders and collections only)', async () => {
      const res = await get(`/api/v1/reports/payments?dateFrom=${today}&dateTo=${today}`);
      expect(res.status).toBe(200);
      // 100 + 50 orders, 40 POS, 20 exchange at the counter, 15 collected.
      expect(res.body.summary).toEqual({ totalCollected: 225, totalRefunded: 40, netCollected: 185, pendingPayments: 0 });
    });

    it('gives back order and return refunds (was: order refunds only)', async () => {
      const res = await get(`/api/v1/reports/payments?dateFrom=${today}&dateTo=${today}`);
      expect(res.body.byPeriod).toEqual([expect.objectContaining({ collected: 225, refunded: 40 })]);
    });

    it('lists methods by their codes (was: mobile relabelled Telebirr)', async () => {
      const res = await get(`/api/v1/reports/payments?dateFrom=${today}&dateTo=${today}`);
      expect(res.body.byMethod).toEqual([
        { method: 'cash', total: 175, count: 4 },
        { method: 'mobile', total: 50, count: 1 },
      ]);
    });
  });

  describe('voided exchanges', () => {
    it('are not counted in the exchange report (was: counted)', async () => {
      const res = await get(`/api/v1/reports/exchanges?dateFrom=${today}&dateTo=${today}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.totalExchanges).toBe(2);
    });

    it('take no money in the payments ledger (was: their payment in, with no refund out)', async () => {
      const res = await get(`/api/v1/reports/payments-ledger?dateFrom=${today}&dateTo=${today}`);
      expect(res.status).toBe(200);
      const exchanges = res.body.rows.filter((r: { referenceType: string }) => r.referenceType === 'EXCHANGE');
      expect(exchanges.map((r: { referenceNo: string; amount: number; direction: string }) => [r.referenceNo, r.amount, r.direction]).sort())
        .toEqual([[`${REF}E1`, 20, 'IN'], [`${REF}E3`, 15, 'IN']]);
    });
  });

  it('the payments ledger lists the collection of an exchange difference (was: left out)', async () => {
    const res = await get(`/api/v1/reports/payments-ledger?dateFrom=${today}&dateTo=${today}`);
    expect(res.body.rows).toContainEqual(expect.objectContaining({ referenceNo: `${REF}E3`, amount: 15, direction: 'IN', paymentMethod: 'cash' }));
  });

  it('the procurement export names each PO by its reference (was: the bare id)', async () => {
    const res = await get(`/api/v1/reports/procurement/export?dateFrom=${today}&dateTo=${today}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`PO-${String(poId).padStart(6, '0')}`);
  });

  it('ages what is owed to a supplier by days since the goods arrived', async () => {
    const res = await get('/api/v1/reports/procurement/ap-aging');
    expect(res.body.rows).toEqual([expect.objectContaining({ poReference: `PO-${String(poId).padStart(6, '0')}`, outstandingAmount: 12, agingBucket: '31-60' })]);
    expect(res.body.byBucket).toContainEqual({ bucket: '31-60', count: 1, totalOutstanding: 12 });
  });

  it('refuses a top-returned limit out of range with 400 (was: any number)', async () => {
    const res = await get('/api/v1/reports/returns/top?limit=1000');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  describe('contracts', () => {
    it('answers with the shared schemas', async () => {
      const cases: [string, { parse: (v: unknown) => unknown }][] = [
        ['/api/v1/reports/payments?groupBy=week', PaymentReportSchema.strict()],
        ['/api/v1/reports/payments-ledger', PaymentsLedgerSchema.strict()],
        ['/api/v1/reports/exchanges?groupBy=month', ExchangeReportSchema.strict()],
        ['/api/v1/reports/exchanges/detail', ExchangeDetailResponseSchema.strict()],
        ['/api/v1/reports/returns', ReturnReportResponseSchema.strict()],
        ['/api/v1/reports/returns/top?limit=5', TopReturnedBooksSchema],
        ['/api/v1/reports/procurement/open-pos', OpenPurchaseOrdersSchema],
        ['/api/v1/reports/procurement/supplier-balances', SupplierBalancesSchema],
        ['/api/v1/reports/procurement/ap-aging', ApAgingSchema.strict()],
        ['/api/v1/reports/procurement/purchases-by-supplier', PurchasesBySupplierSchema],
        ['/api/v1/reports/procurement/purchases-by-book', PurchasesByBookSchema],
        ['/api/v1/reports/procurement/supplier-payment-history', SupplierPaymentHistorySchema],
      ];
      for (const [path, schema] of cases) {
        const res = await get(path);
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
        expect(schema.parse(res.body)).toEqual(res.body);
      }
    });

    it.each([
      '/api/v1/reports/payments/export',
      '/api/v1/reports/payments-ledger/export',
      '/api/v1/reports/exchanges/export',
      '/api/v1/reports/returns/export',
      '/api/v1/reports/procurement/export',
      '/api/v1/reports/procurement/open-pos/export',
      '/api/v1/reports/procurement/supplier-balances/export',
      '/api/v1/reports/procurement/ap-aging/export',
      '/api/v1/reports/procurement/purchases-by-supplier/export',
      '/api/v1/reports/procurement/purchases-by-book/export',
      '/api/v1/reports/procurement/supplier-payment-history/export',
    ])('still exports %s as CSV', async (path) => {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
    });

    it('refuses an impossible date with 400', async () => {
      const res = await get('/api/v1/reports/procurement/purchases-by-book?dateFrom=2026-13-01');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });
});
