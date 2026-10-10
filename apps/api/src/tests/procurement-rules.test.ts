import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Purchase orders after the move to the layered structure (#21, procurement
// part 1). Each test names what the endpoint did before.

const STAFF_PREFIX = 'porule_test_';
const BRANCH_PREFIX = 'Po Rule ';
const SUPPLIER_PREFIX = 'Po Rule Supplier';

interface Po {
  id: string;
  status: string;
  lineItems: Array<{ id: string; remaining: number }>;
}

describe('Purchase orders', () => {
  let branchA: number;
  let branchB: number;
  let locA: number;
  let locB1: number;
  let locB2: number;
  let supplierId: number;
  let bookId: number;
  // Branch A orders; branch B receives.
  let purchasorA: string;
  let managerA: string;
  let managerA2: string;
  let managerB: string;
  let clerkB: string;
  let restrictedClerkB: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string, branchId = branchA) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

  async function create(body: Record<string, unknown> = {}, token = purchasorA): Promise<Po> {
    const res = await as(api().post('/api/v1/purchase-orders'), token).send({
      supplierId, receivingBranchId: branchB, lineItems: [{ bookId, quantity: 10, unitCost: 5 }], ...body,
    });
    expect(res.status).toBe(201);
    return res.body as Po;
  }

  const act = (po: Po, action: string, token: string, branchId = branchA, body: Record<string, unknown> = {}) =>
    as(api().post(`/api/v1/purchase-orders/${po.id}/${action}`), token, branchId).send(body);

  /** Submitted below the threshold, so approved on submit, then sent to the supplier. */
  async function ordered(body: Record<string, unknown> = {}): Promise<Po> {
    const po = await create(body);
    expect((await act(po, 'submit', purchasorA)).body.status).toBe('approved');
    expect((await act(po, 'order', purchasorA)).status).toBe(200);
    return po;
  }

  const receive = (po: Po, quantity: number, token = clerkB, body: Record<string, unknown> = {}) =>
    act(po, 'receive', token, branchB, { items: [{ poLineItemId: Number(po.lineItems[0].id), quantityReceived: quantity }], ...body });

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

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    const loc = async (branchId: number, name: string, isDefault: boolean) =>
      (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, $3) RETURNING id`, [branchId, name, isDefault])).id;
    locA = await loc(branchA, 'Po Rule A', true);
    locB1 = await loc(branchB, 'Po Rule B1', true);
    locB2 = await loc(branchB, 'Po Rule B2', false);

    purchasorA = (await createTestStaff({ username: `${STAFF_PREFIX}purch_a`, role: 'Purchasor', branchId: branchA })).token;
    managerA = (await createTestStaff({ username: `${STAFF_PREFIX}mgr_a`, role: 'Manager', branchId: branchA })).token;
    managerA2 = (await createTestStaff({ username: `${STAFF_PREFIX}mgr_a2`, role: 'Manager', branchId: branchA })).token;
    managerB = (await createTestStaff({ username: `${STAFF_PREFIX}mgr_b`, role: 'Manager', branchId: branchB })).token;
    clerkB = (await createTestStaff({ username: `${STAFF_PREFIX}clerk_b`, role: 'Stock_Clerk', branchId: branchB })).token;
    const restricted = await createTestStaff({ username: `${STAFF_PREFIX}clerk_b2`, role: 'Stock_Clerk', branchId: branchB });
    restrictedClerkB = restricted.token;
    // Assigned to the branch's default location only.
    await db.query(`INSERT INTO staff_locations (staff_id, location_id) VALUES ($1, $2)`, [restricted.staffId, locB1]);

    supplierId = (await one(
      `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type) VALUES ($1, '{}', 7, 'external') RETURNING id`,
      [SUPPLIER_PREFIX],
    )).id;
    bookId = (await one(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 1`)).id;
  });

  afterAll(cleanUp);

  describe('which branch does what', () => {
    it('lets only the receiving branch receive (was: the ordering branch could book goods into its stock, #66)', async () => {
      const po = await ordered();
      const denied = await act(po, 'receive', managerA, branchA, { items: [{ poLineItemId: Number(po.lineItems[0].id), quantityReceived: 1 }] });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBe('BRANCH_ACCESS_DENIED');

      const res = await receive(po, 4);
      expect(res.status).toBe(200);
      const stock = await one(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locB1]);
      expect(stock.quantity).toBe(4);
    });

    it('leaves buying to the ordering branch (was: the receiving branch could approve and cancel)', async () => {
      const po = await create({ lineItems: [{ bookId, quantity: 200, unitCost: 10 }] });
      expect((await act(po, 'submit', purchasorA)).body.status).toBe('pending_approval');
      const approve = await act(po, 'approve', managerB, branchB);
      expect(approve.status).toBe(403);
      expect(approve.body.error).toBe('BRANCH_ACCESS_DENIED');
      expect((await act(po, 'cancel', managerB, branchB)).status).toBe(403);
    });

    it("lists an order in the receiving branch too (was: only the ordering branch's list)", async () => {
      const po = await create();
      const res = await as(api().get('/api/v1/purchase-orders?pageSize=100'), clerkB, branchB);
      expect(res.status).toBe(200);
      expect(res.body.items.map((p: Po) => p.id)).toContain(po.id);
    });

    it("checks the order's receiving location against the clerk's assignments when none is named (was: checked the branch default)", async () => {
      const po = await ordered({ receivingLocationId: locB2 });
      const res = await receive(po, 1, restrictedClerkB);
      expect(res.status).toBe(403);
      expect((await receive(po, 1, restrictedClerkB, { locationId: locB1 })).status).toBe(200);
    });

    it("takes the new receiving branch's default location when only the branch changes (was: kept the old branch's)", async () => {
      const po = await create({ receivingBranchId: branchA });
      const res = await as(api().put(`/api/v1/purchase-orders/${po.id}`), purchasorA).send({ receivingBranchId: branchB });
      expect(res.status).toBe(200);
      expect(res.body.receivingBranchId).toBe(branchB);
      expect(res.body.receivingLocationId).toBe(locB1);
    });
  });

  describe('approval', () => {
    it('refuses self-approval (was: the creator could approve their own order)', async () => {
      const po = await create({ lineItems: [{ bookId, quantity: 200, unitCost: 10 }] }, managerA);
      await act(po, 'submit', managerA);
      const self = await act(po, 'approve', managerA);
      expect(self.status).toBe(422);
      expect(self.body.error).toBe('SELF_APPROVAL_NOT_ALLOWED');
      expect((await act(po, 'approve', managerA2)).body.status).toBe('approved');
    });

    it('lets only one of two simultaneous approvals through', async () => {
      const po = await create({ lineItems: [{ bookId, quantity: 200, unitCost: 10 }] });
      await act(po, 'submit', purchasorA);
      const results = await Promise.all([act(po, 'approve', managerA), act(po, 'approve', managerA2)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    });

    it('refuses to approve or order from a supplier blacklisted since the draft (was: approved and ordered)', async () => {
      const po = await create();
      await act(po, 'submit', purchasorA);
      await db.query(`UPDATE suppliers SET is_blacklisted = true WHERE id = $1`, [supplierId]);
      try {
        const res = await act(po, 'order', purchasorA);
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('SUPPLIER_BLACKLISTED');
      } finally {
        await db.query(`UPDATE suppliers SET is_blacklisted = false WHERE id = $1`, [supplierId]);
      }
    });
  });

  describe('when the supplier does not deliver', () => {
    it('cancels an ordered order while nothing arrived (was: 422 PO_INVALID_STATUS)', async () => {
      const po = await ordered();
      const res = await act(po, 'cancel', purchasorA);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
    });

    it('closes a part-received order short, with a reason (was: 422, it stayed open)', async () => {
      const po = await ordered();
      expect((await receive(po, 3)).status).toBe(200);

      const noReason = await act(po, 'close', managerA);
      expect(noReason.status).toBe(400);
      const res = await act(po, 'close', managerA, branchA, { reason: 'Supplier out of stock' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('closed');
      expect(res.body.closedReason).toBe('Supplier out of stock');
      expect(res.body.lineItems[0].remaining).toBe(0);
      expect(res.body.outstandingAmount).toBe(15);
    });
  });

  describe('value and currency', () => {
    it('receives free copies at cost zero, lowering the average cost (was: 400, could not be received)', async () => {
      const paid = await ordered({ lineItems: [{ bookId, quantity: 10, unitCost: 8 }], receivingBranchId: branchA });
      expect((await act(paid, 'receive', managerA, branchA, { items: [{ poLineItemId: Number(paid.lineItems[0].id), quantityReceived: 10 }] })).status).toBe(200);
      const free = await ordered({ lineItems: [{ bookId, quantity: 10, unitCost: 0 }], receivingBranchId: branchA });
      const res = await act(free, 'receive', managerA, branchA, { items: [{ poLineItemId: Number(free.lineItems[0].id), quantityReceived: 10 }] });
      expect(res.status).toBe(200);
      const stock = await one(`SELECT quantity, average_cost FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locA]);
      expect(stock.quantity).toBe(20);
      expect(Number(stock.average_cost)).toBe(4);
    });

    it('keeps orders in ETB (was: USD by default, any currency accepted)', async () => {
      const po = await create();
      expect((await one(`SELECT currency FROM purchase_orders WHERE id = $1`, [po.id])).currency).toBe('ETB');
      const usd = await as(api().post('/api/v1/purchase-orders'), purchasorA).send({
        supplierId, currency: 'USD', lineItems: [{ bookId, quantity: 1, unitCost: 5 }],
      });
      expect(usd.status).toBe(400);
    });
  });

  describe('records', () => {
    it('lists the orders of the last day asked for (was: dateTo left that day out)', async () => {
      const po = await create();
      const { today } = await one(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
      const res = await as(api().get(`/api/v1/purchase-orders?dateFrom=${today}&dateTo=${today}&pageSize=100`), purchasorA);
      expect(res.status).toBe(200);
      expect(res.body.items.map((p: Po) => p.id)).toContain(po.id);
    });

    it('names the order PO-000123 in the created notification (was: its bare id)', async () => {
      const po = await create();
      const event = await one(`SELECT payload FROM outbox WHERE event_type = 'po.created' AND payload->>'poId' = $1`, [po.id]);
      expect(event.payload.poNumber).toBe(`PO-${po.id.padStart(6, '0')}`);
    });
  });
});
