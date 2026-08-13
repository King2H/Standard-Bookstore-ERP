/**
 * Prompt 2 — Production-Grade Procurement Lifecycle: credit notes, supplier
 * ledger, received-value payable basis, and procurement reports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'proc2_test_';
const BRANCH_PREFIX = 'Proc2 Test ';
const NOTES_MARK = 'proc2_test';

async function cleanTestPOs() {
  await db.query(`DELETE FROM supplier_credit_notes WHERE po_id IN (SELECT id FROM purchase_orders WHERE notes LIKE $1)`, [`%${NOTES_MARK}%`]);
  await db.query(`DELETE FROM po_receipt_items WHERE receipt_id IN (SELECT id FROM po_receipts WHERE po_id IN (SELECT id FROM purchase_orders WHERE notes LIKE $1))`, [`%${NOTES_MARK}%`]);
  await db.query(`DELETE FROM po_receipts WHERE po_id IN (SELECT id FROM purchase_orders WHERE notes LIKE $1)`, [`%${NOTES_MARK}%`]);
  await db.query(`DELETE FROM supplier_payments WHERE po_id IN (SELECT id FROM purchase_orders WHERE notes LIKE $1)`, [`%${NOTES_MARK}%`]);
  await db.query(`DELETE FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE notes LIKE $1)`, [`%${NOTES_MARK}%`]);
  await db.query(`DELETE FROM purchase_orders WHERE notes LIKE $1`, [`%${NOTES_MARK}%`]);
}

async function getTestBook(): Promise<number> {
  const result = await db.query(`SELECT id FROM books WHERE is_active = true LIMIT 1`);
  if (!result.rows.length) throw new Error('No active books found');
  return result.rows[0].id as number;
}

describe('Procurement — Prompt 2 (credit notes, supplier ledger, received-value basis, reports)', () => {
  let adminToken: string;
  let financeToken: string;
  let branchId: number;
  let locationId: number;
  let supplierId: number;
  let bookId: number;

  beforeAll(async () => {
    await cleanTestPOs();
    await db.query(`DELETE FROM suppliers WHERE name LIKE 'Proc2 Test Supplier%'`).catch(() => {});
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Proc2 Test Branch' });
    branchId = branch.branchId;
    const admin = await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId });
    adminToken = admin.token;
    const finance = await createTestStaff({ username: `${STAFF_PREFIX}finance`, role: 'Finance_Officer', branchId });
    financeToken = finance.token;

    const locRes = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Proc2 Test Location', true) RETURNING id`,
      [branchId],
    );
    locationId = locRes.rows[0].id as number;

    const supRes = await db.query(
      `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type)
       VALUES ('Proc2 Test Supplier', '{"phone":"555-P2"}', 5, 'external') RETURNING id`,
    );
    supplierId = supRes.rows[0].id as number;

    bookId = await getTestBook();
  });

  afterAll(async () => {
    await cleanTestPOs();
    await db.query(`DELETE FROM suppliers WHERE name LIKE 'Proc2 Test Supplier%'`).catch(() => {});
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  async function createApprovedPO(
    qty: number,
    unitCost: number,
    paymentTerms: 'cash' | 'credit' = 'credit',
    supplierIdOverride?: number,
  ): Promise<{ poId: number; lineItemId: number }> {
    const createRes = await request(getTestApp())
      .post('/api/purchase-orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ supplierId: supplierIdOverride ?? supplierId, branchId, paymentTerms, notes: `${NOTES_MARK} PO`, lineItems: [{ bookId, quantity: qty, unitCost }] });
    expect(createRes.status).toBe(201);
    const poId = createRes.body.id;
    const lineItemId = Number(createRes.body.lineItems[0].id);
    await request(getTestApp()).post(`/api/purchase-orders/${poId}/submit`).set('Authorization', `Bearer ${adminToken}`).set('X-Branch-Id', String(branchId));
    await request(getTestApp()).post(`/api/purchase-orders/${poId}/approve`).set('Authorization', `Bearer ${adminToken}`).set('X-Branch-Id', String(branchId));
    await request(getTestApp()).post(`/api/purchase-orders/${poId}/order`).set('Authorization', `Bearer ${adminToken}`).set('X-Branch-Id', String(branchId));
    return { poId, lineItemId };
  }

  it('1. PO financial fields: receivedValue basis, not full totalAmount, before receiving anything', async () => {
    const { poId } = await createApprovedPO(10, 20); // total_amount = 200
    const res = await request(getTestApp())
      .get(`/api/purchase-orders/${poId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(res.status).toBe(200);
    expect(Number(res.body.totalAmount)).toBeCloseTo(200, 2);
    // Nothing received yet — the payable basis is 0, not the full 200.
    expect(Number(res.body.receivedValue)).toBeCloseTo(0, 2);
    expect(Number(res.body.outstandingAmount)).toBeCloseTo(0, 2);
    expect(res.body.financialStatus).toBe('unpaid');
  });

  it('2. Credit note reduces outstanding balance and moves financialStatus to paid', async () => {
    const { poId, lineItemId } = await createApprovedPO(5, 30); // received value will be 150
    const receiveRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ poLineItemId: lineItemId, quantityReceived: 5 }] });
    expect(receiveRes.status).toBe(200);

    const afterReceive = await request(getTestApp())
      .get(`/api/purchase-orders/${poId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(Number(afterReceive.body.receivedValue)).toBeCloseTo(150, 2);
    expect(afterReceive.body.financialStatus).toBe('unpaid');

    // Credit note for damaged goods covering the full received value.
    const cnRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/credit-notes`)
      .set('Authorization', `Bearer ${financeToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ amount: 150, reason: 'proc2_test damaged goods' });
    expect(cnRes.status).toBe(201);
    expect(Number(cnRes.body.creditNotesTotal)).toBeCloseTo(150, 2);
    expect(Number(cnRes.body.outstandingAmount)).toBeCloseTo(0, 2);
    expect(cnRes.body.financialStatus).toBe('paid');
    expect(cnRes.body.creditNotes.length).toBe(1);
    expect(cnRes.body.creditNotes[0].reason).toBe('proc2_test damaged goods');
  });

  it('3. Credit note rejects zero/negative amount and a blank reason', async () => {
    const { poId, lineItemId } = await createApprovedPO(2, 10);
    await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ poLineItemId: lineItemId, quantityReceived: 2 }] });

    const zeroRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/credit-notes`)
      .set('Authorization', `Bearer ${financeToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ amount: 0, reason: 'proc2_test bad' });
    expect(zeroRes.status).toBe(400);

    const blankReasonRes = await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/credit-notes`)
      .set('Authorization', `Bearer ${financeToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ amount: 5, reason: '' });
    expect(blankReasonRes.status).toBe(400);
  });

  it('4. Supplier ledger shows PO / Goods Receipt / Payment rows with a correct running balance', async () => {
    // Uses a dedicated supplier so the running balance is computed over a
    // clean history, unaffected by the other POs created in tests 1-3
    // against the shared `supplierId`.
    const supRes = await db.query(
      `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type)
       VALUES ('Proc2 Test Supplier Ledger', '{"phone":"555-P2L"}', 5, 'external') RETURNING id`,
    );
    const ledgerSupplierId = supRes.rows[0].id as number;

    const { poId, lineItemId } = await createApprovedPO(4, 25, 'credit', ledgerSupplierId); // received value 100

    await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ poLineItemId: lineItemId, quantityReceived: 4 }] });

    await request(getTestApp())
      .post(`/api/purchase-orders/${poId}/payments`)
      .set('Authorization', `Bearer ${financeToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ amount: 60, paymentMethod: 'bank_transfer' });

    const ledgerRes = await request(getTestApp())
      .get(`/api/suppliers/${ledgerSupplierId}/ledger`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(ledgerRes.status).toBe(200);
    const types = ledgerRes.body.entries.map((e: { type: string }) => e.type);
    expect(types).toContain('PO');
    expect(types).toContain('GOODS_RECEIPT');
    expect(types).toContain('PAYMENT');

    // Running balance: +100 (receipt) - 60 (payment) = 40 owed.
    expect(Number(ledgerRes.body.currentBalance)).toBeCloseTo(40, 2);
    const lastEntry = ledgerRes.body.entries[ledgerRes.body.entries.length - 1];
    expect(Number(lastEntry.balance)).toBeCloseTo(40, 2);
  });

  it('5. Procurement reports respond with the expected shape', async () => {
    const openPos = await request(getTestApp())
      .get(`/api/reports/procurement/open-pos?branchId=${branchId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(openPos.status).toBe(200);
    expect(Array.isArray(openPos.body)).toBe(true);

    const balances = await request(getTestApp())
      .get(`/api/reports/procurement/supplier-balances?branchId=${branchId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(balances.status).toBe(200);
    const ours = balances.body.find((r: { supplier: string }) => r.supplier === 'Proc2 Test Supplier');
    expect(ours).toBeDefined();

    const aging = await request(getTestApp())
      .get(`/api/reports/procurement/ap-aging?branchId=${branchId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(aging.status).toBe(200);
    expect(aging.body.byBucket.length).toBe(5);

    const byBook = await request(getTestApp())
      .get(`/api/reports/procurement/purchases-by-book?branchId=${branchId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(byBook.status).toBe(200);

    const paymentHistory = await request(getTestApp())
      .get(`/api/reports/procurement/supplier-payment-history?branchId=${branchId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(paymentHistory.status).toBe(200);
    expect(paymentHistory.body.length).toBeGreaterThan(0);
  });
});
