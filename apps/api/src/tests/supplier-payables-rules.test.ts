import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Supplier payables after the move to the layered structure (#21,
// procurement part 2). Each test names what the endpoint did before.

const STAFF_PREFIX = 'payrule_test_';
const BRANCH_PREFIX = 'Pay Rule ';
const SUPPLIER_PREFIX = 'Pay Rule Supplier';

interface Po {
  id: string;
  status: string;
  amountPaid: number;
  outstandingAmount: number;
  financialStatus: string;
  lineItems: Array<{ id: string }>;
  payments: Array<{ id: string; paymentNumber: string | null; reversedAt: string | null; reversalReason: string | null; paymentMethod: string }>;
  creditNotes: Array<{ id: string; creditNoteNumber: string | null }>;
}

describe('Supplier payables', () => {
  let branchA: number;
  let branchB: number;
  let supplierId: number;
  let bookId: number;
  let purchasorA: string;
  let financeA: string;
  let financeB: string;
  let clerkA: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string, branchId = branchA) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

  /** An approved order of 10 × 10 (total 100), from `branch` and received there unless `receivingBranchId`. */
  async function approved(body: Record<string, unknown> = {}, supplier = supplierId): Promise<Po> {
    const created = await as(api().post('/api/v1/purchase-orders'), purchasorA).send({
      supplierId: supplier, lineItems: [{ bookId, quantity: 10, unitCost: 10 }], ...body,
    });
    expect(created.status).toBe(201);
    expect((await as(api().post(`/api/v1/purchase-orders/${created.body.id}/submit`), purchasorA)).body.status).toBe('approved');
    return created.body as Po;
  }

  async function received(po: Po, quantity: number): Promise<void> {
    const res = await as(api().post(`/api/v1/purchase-orders/${po.id}/receive`), clerkA).send({
      items: [{ poLineItemId: Number(po.lineItems[0].id), quantityReceived: quantity }],
    });
    expect(res.status).toBe(200);
  }

  const pay = (po: Po, amount: number | string, token = financeA, branchId = branchA, extra: Record<string, unknown> = {}) =>
    as(api().post(`/api/v1/purchase-orders/${po.id}/payments`), token, branchId).send({ amount, paymentMethod: 'bank', ...extra });
  const credit = (po: Po, amount: number) =>
    as(api().post(`/api/v1/purchase-orders/${po.id}/credit-notes`), financeA).send({ amount, reason: 'Damaged copies' });
  const reverse = (po: Po, paymentId: string, reason = 'Entered on the wrong order') =>
    as(api().post(`/api/v1/purchase-orders/${po.id}/payments/${paymentId}/reverse`), financeA).send({ reason });
  const ledger = (supplier: number, token = financeA, query = '') =>
    as(api().get(`/api/v1/suppliers/${supplier}/ledger${query}`), token);

  async function cleanUp() {
    const pos = `SELECT id FROM purchase_orders WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE '${SUPPLIER_PREFIX}%')`;
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    for (const statement of [
      `DELETE FROM po_receipt_items WHERE receipt_id IN (SELECT id FROM po_receipts WHERE po_id IN (${pos}))`,
      `DELETE FROM po_receipts WHERE po_id IN (${pos})`,
      `DELETE FROM supplier_payments WHERE po_id IN (${pos})`,
      `DELETE FROM supplier_credit_notes WHERE po_id IN (${pos})`,
      `DELETE FROM po_line_items WHERE po_id IN (${pos})`,
      `DELETE FROM purchase_orders WHERE id IN (${pos})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM suppliers WHERE name LIKE '${SUPPLIER_PREFIX}%'`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  async function newSupplier(name: string): Promise<number> {
    return (await one(
      `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type) VALUES ($1, '{}', 7, 'external') RETURNING id`,
      [name],
    )).id;
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Pay Rule A', true), ($2, 'Pay Rule B', true)`, [branchA, branchB]);
    purchasorA = (await createTestStaff({ username: `${STAFF_PREFIX}purch_a`, role: 'Purchasor', branchId: branchA })).token;
    financeA = (await createTestStaff({ username: `${STAFF_PREFIX}fin_a`, role: 'Finance_Officer', branchId: branchA })).token;
    financeB = (await createTestStaff({ username: `${STAFF_PREFIX}fin_b`, role: 'Finance_Officer', branchId: branchB })).token;
    clerkA = (await createTestStaff({ username: `${STAFF_PREFIX}clerk_a`, role: 'Stock_Clerk', branchId: branchA })).token;
    supplierId = await newSupplier(SUPPLIER_PREFIX);
    bookId = (await one(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 1`)).id;
  });

  afterAll(cleanUp);

  describe('paying', () => {
    it('lets only the ordering branch pay (was: the receiving branch could too)', async () => {
      const po = await approved({ receivingBranchId: branchB });
      const res = await pay(po, 10, financeB, branchB);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('BRANCH_ACCESS_DENIED');
      expect((await pay(po, 10)).status).toBe(201);
    });

    it('keeps payments and credit notes within the ordered total, advances allowed (was: any amount)', async () => {
      const po = await approved();
      expect((await pay(po, 60)).status).toBe(201);
      expect((await credit(po, 30)).status).toBe(201);
      const over = await pay(po, 20);
      expect(over.status).toBe(422);
      expect(over.body.error).toBe('EXCEEDS_ORDER_TOTAL');
      expect((await credit(po, 11)).status).toBe(422);
      const exact = await pay(po, 10);
      expect(exact.status).toBe(201);
      expect(exact.body.amountPaid).toBe(70);
    });

    it('refuses a method outside cash, bank, mobile and cheque (was: any text stored)', async () => {
      const po = await approved();
      expect((await pay(po, 5, financeA, branchA, { paymentMethod: 'bank_transfer' })).status).toBe(400);
      const res = await pay(po, 5, financeA, branchA, { paymentMethod: 'mobile' });
      expect(res.status).toBe(201);
      expect(res.body.payments[0].paymentMethod).toBe('mobile');
    });

    it('refuses a fraction of a cent with 400 (was: 500)', async () => {
      const po = await approved();
      expect((await pay(po, 0.001)).status).toBe(400);
    });

    it('numbers payments and credit notes, cash on delivery too (was: no number)', async () => {
      const po = await approved();
      const paid = await pay(po, 10);
      expect(paid.body.payments[0].paymentNumber).toMatch(/^SPAY-\d{8}-\d{4}$/);
      const credited = await credit(po, 5);
      expect(credited.body.creditNotes[0].creditNoteNumber).toMatch(/^SCN-\d{8}-\d{4}$/);

      const cash = await approved({ paymentTerms: 'cash' });
      await received(cash, 2);
      const after = await as(api().get(`/api/v1/purchase-orders/${cash.id}`), financeA);
      expect(after.body.payments[0].paymentNumber).toMatch(/^SPAY-\d{8}-\d{4}$/);
    });

    it("audits a payment under its own id (was: the order's)", async () => {
      const po = await approved();
      const paid = await pay(po, 10);
      const entry = await one(
        `SELECT entity_id FROM audit_logs WHERE entity_type = 'supplier_payment' ORDER BY id DESC LIMIT 1`,
      );
      expect(entry.entity_id).toBe(paid.body.payments[0].id);
    });
  });

  describe('reversing a payment', () => {
    it('reverses a mistaken payment, keeping it on record (was: no way to undo it)', async () => {
      const po = await approved();
      await received(po, 10);
      const paid = await pay(po, 100);
      expect(paid.body.financialStatus).toBe('paid');

      const res = await reverse(po, paid.body.payments[0].id);
      expect(res.status).toBe(200);
      expect(res.body.amountPaid).toBe(0);
      expect(res.body.outstandingAmount).toBe(100);
      expect(res.body.financialStatus).toBe('unpaid');
      expect(res.body.payments[0].reversedAt).not.toBeNull();
      expect(res.body.payments[0].reversalReason).toBe('Entered on the wrong order');

      const again = await reverse(po, paid.body.payments[0].id);
      expect(again.status).toBe(422);
      expect(again.body.error).toBe('ALREADY_REVERSED');
      // The order can be paid again in full.
      expect((await pay(po, 100)).status).toBe(201);
    });

    it('needs a reason', async () => {
      const po = await approved();
      const paid = await pay(po, 10);
      expect((await reverse(po, paid.body.payments[0].id, ' ')).status).toBe(400);
    });
  });

  describe('the supplier ledger', () => {
    it("shows the session branch's orders only (was: every branch's)", async () => {
      const supplier = await newSupplier(`${SUPPLIER_PREFIX} Ledger`);
      const own = await approved({}, supplier);
      await received(own, 4);
      const purchasorB = (await createTestStaff({ username: `${STAFF_PREFIX}purch_b`, role: 'Purchasor', branchId: branchB })).token;
      const other = await as(api().post('/api/v1/purchase-orders'), purchasorB, branchB).send({
        supplierId: supplier, lineItems: [{ bookId, quantity: 1, unitCost: 10 }],
      });
      await as(api().post(`/api/v1/purchase-orders/${other.body.id}/submit`), purchasorB, branchB);

      const res = await ledger(supplier);
      expect(res.status).toBe(200);
      const refs = res.body.entries.map((e: { reference: string }) => e.reference).join(' ');
      expect(refs).toContain(`PO-${own.id.padStart(6, '0')}`);
      expect(refs).not.toContain(`PO-${String(other.body.id).padStart(6, '0')}`);
      expect(res.body.currentBalance).toBe(40);
    });

    it('leaves out orders still waiting for approval (was: listed as owed for)', async () => {
      const supplier = await newSupplier(`${SUPPLIER_PREFIX} Pending`);
      const created = await as(api().post('/api/v1/purchase-orders'), purchasorA).send({
        supplierId: supplier, lineItems: [{ bookId, quantity: 200, unitCost: 10 }],
      });
      expect((await as(api().post(`/api/v1/purchase-orders/${created.body.id}/submit`), purchasorA)).body.status).toBe('pending_approval');
      expect((await ledger(supplier)).body.entries).toEqual([]);
    });

    it('shows a reversed payment and its reversal, the balance back where it was', async () => {
      const supplier = await newSupplier(`${SUPPLIER_PREFIX} Reversal`);
      const po = await approved({}, supplier);
      await received(po, 10);
      const paid = await pay(po, 30);
      await reverse(po, paid.body.payments[0].id);
      const res = await ledger(supplier);
      expect(res.body.entries.map((e: { type: string }) => e.type)).toEqual(['PO', 'GOODS_RECEIPT', 'PAYMENT', 'PAYMENT_REVERSAL']);
      expect(res.body.currentBalance).toBe(100);
    });

    it('refuses a date that is not a date (was: ignored it)', async () => {
      expect((await ledger(supplierId, financeA, '?dateTo=yesterday')).status).toBe(400);
    });
  });
});
