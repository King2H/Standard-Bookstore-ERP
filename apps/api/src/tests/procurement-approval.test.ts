import { createRequire } from 'node:module';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { ownerDb } from './helpers/ownerDb.js';
import { DEFAULT_ADMIN_PASSWORD_HASH } from '../db/seed.js';

// #164: an order above the approval threshold waits for an Admin or Manager
// other than its creator. A shop whose only approver created the order was
// stuck: nobody could approve it, so it could never be ordered, received or
// closed. The only approver now approves it with a reason, audited and
// notified (2a); the order records how and when it was approved and says what
// its approval waits for (1a); Super_Admin does not approve (3a).
//
// Each test runs in its own tenant, so the approvers in its branch are exactly
// the ones it creates.

const PREFIX = 'poappr_test_';
const TENANT_PREFIX = 'PO Approval Test ';
const PASSWORD = 'Admin@1234'; // DEFAULT_ADMIN_PASSWORD_HASH

type Shop = { tenant: number; branch: number; location: number; supplier: number; book: number };

describe('Purchase order approval (#164)', () => {
  const api = () => request(getTestApp());
  const owner = () => ownerDb();
  let shops = 0;

  async function cleanUp() {
    const tenants = `SELECT id FROM tenants WHERE name LIKE '${TENANT_PREFIX}%'`;
    const db = owner();
    await db.query(`DELETE FROM refresh_tokens WHERE session_id IN (SELECT id FROM staff_sessions WHERE tenant_id IN (${tenants}))`);
    for (const table of [
      'audit_logs', 'outbox', 'notification_reads', 'notifications', 'inventory_history', 'inventory', 'po_receipt_items', 'po_receipts', 'po_line_items',
      'purchase_orders', 'books', 'suppliers', 'system_config', 'staff_branch_roles', 'staff_sessions', 'staff', 'locations', 'branches',
    ]) {
      await db.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenants})`);
    }
    await db.query(`DELETE FROM tenants WHERE name LIKE '${TENANT_PREFIX}%'`);
  }

  async function shop(): Promise<Shop> {
    const db = owner();
    const tenant = (await db.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`${TENANT_PREFIX}${++shops}`])).rows[0].id;
    const one = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0].id as number;
    const branch = await one(
      `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, 'Main Branch', '-', '{}', '{}') RETURNING id`, [tenant],
    );
    const location = await one(`INSERT INTO locations (tenant_id, branch_id, name) VALUES ($1, $2, 'Shelf') RETURNING id`, [tenant, branch]);
    const supplier = await one(`INSERT INTO suppliers (tenant_id, name, contact_info) VALUES ($1, 'Supplier', '{}') RETURNING id`, [tenant]);
    const book = await one(`INSERT INTO books (tenant_id, isbn, title) VALUES ($1, '9780000000001', 'Approval Book') RETURNING id`, [tenant]);
    await db.query(
      `INSERT INTO system_config (tenant_id, key, value, updated_by) VALUES ($1, 'po_approval_threshold', '1000', 1), ($1, 'base_currency', '"ETB"', 1)`,
      [tenant],
    );
    return { tenant, branch, location, supplier, book };
  }

  /** A staff member of the shop holding `role` in its branch (or elsewhere, with access to all branches); signed in. */
  async function staff(s: Shop, name: string, role: string, opts: { branch?: number; allBranches?: boolean; active?: boolean } = {}) {
    const db = owner();
    const id = (await db.query(
      `INSERT INTO staff (tenant_id, username, password_hash, full_name, is_active, must_change_password, is_all_branches)
       VALUES ($1, $2, $3, $2, true, false, $4) RETURNING id`,
      [s.tenant, `${PREFIX}${s.tenant}_${name}`, DEFAULT_ADMIN_PASSWORD_HASH, opts.allBranches ?? false],
    )).rows[0].id as number;
    await db.query(`INSERT INTO staff_branch_roles (tenant_id, staff_id, branch_id, role) VALUES ($1, $2, $3, $4)`, [s.tenant, id, opts.branch ?? s.branch, role]);
    const login = await api().post('/api/v1/auth/login').send({ username: `${PREFIX}${s.tenant}_${name}`, password: PASSWORD, branchId: s.branch });
    expect(login.status).toBe(200);
    if (opts.active === false) await db.query(`UPDATE staff SET is_active = false WHERE id = $1`, [id]);
    return { id, token: login.body.accessToken as string };
  }

  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  /** A submitted order of `total` (one line), created by `token`. */
  async function submitted(s: Shop, token: string, total: number) {
    const created = await as(api().post('/api/v1/purchase-orders'), token).send({
      supplierId: s.supplier, receivingBranchId: s.branch, receivingLocationId: s.location,
      lineItems: [{ bookId: s.book, quantity: 1, unitCost: total }],
    });
    expect(created.status).toBe(201);
    const res = await as(api().post(`/api/v1/purchase-orders/${created.body.id}/submit`), token);
    expect(res.status).toBe(200);
    return res.body;
  }

  const approve = (token: string, id: string, body?: Record<string, unknown>) =>
    as(api().post(`/api/v1/purchase-orders/${id}/approve`), token).send(body ?? {});

  beforeAll(cleanUp);
  afterAll(cleanUp);

  describe('the only approver of the branch (2a)', () => {
    it('approves the order they created, with a reason (was: SELF_APPROVAL_NOT_ALLOWED, and the order stuck in pending approval)', async () => {
      const s = await shop();
      const admin = await staff(s, 'admin', 'Admin');
      const po = await submitted(s, admin.token, 1250);
      expect(po).toMatchObject({ status: 'pending_approval', creatorIsOnlyApprover: true, approvalThreshold: 1000 });

      const noReason = await approve(admin.token, po.id);
      expect(noReason.status).toBe(400);
      expect(noReason.body.error).toBe('VALIDATION_ERROR');

      const res = await approve(admin.token, po.id, { reason: 'Only approver; urgent restock' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'approved', approvedBy: admin.id, approvalKind: 'sole_approver', approvalReason: 'Only approver; urgent restock',
      });
      expect(res.body.approvedAt).toEqual(expect.any(String));

      const audit = (await owner().query(
        `SELECT meta FROM audit_logs WHERE tenant_id = $1 AND entity_type = 'purchase_order' AND entity_id = $2 AND meta->>'action' = 'approve'`,
        [s.tenant, po.id],
      )).rows;
      expect(audit).toEqual([{ meta: expect.objectContaining({ approvalKind: 'sole_approver', reason: 'Only approver; urgent restock' }) }]);
      const event = (await owner().query(
        `SELECT payload FROM outbox WHERE tenant_id = $1 AND event_type = 'po.approved'`, [s.tenant],
      )).rows;
      expect(event).toEqual([{ payload: expect.objectContaining({ approvalKind: 'sole_approver', reason: 'Only approver; urgent restock' }) }]);

      // The rest of the lifecycle follows: ordered, received, closed.
      expect((await as(api().post(`/api/v1/purchase-orders/${po.id}/order`), admin.token)).body.status).toBe('ordered');
      const line = (await as(api().get(`/api/v1/purchase-orders/${po.id}`), admin.token)).body.lineItems[0];
      const received = await as(api().post(`/api/v1/purchase-orders/${po.id}/receive`), admin.token)
        .send({ items: [{ poLineItemId: Number(line.id), quantityReceived: 1 }] });
      expect(received.status).toBe(200);
      expect((await as(api().post(`/api/v1/purchase-orders/${po.id}/close`), admin.token).send({})).body.status).toBe('closed');
    });

    it('is still refused while another Admin or Manager of the branch can approve it', async () => {
      const s = await shop();
      const admin = await staff(s, 'admin', 'Admin');
      const manager = await staff(s, 'manager', 'Manager');
      const po = await submitted(s, admin.token, 1250);
      expect(po.creatorIsOnlyApprover).toBe(false);

      const refused = await approve(admin.token, po.id, { reason: 'In a hurry' });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('SELF_APPROVAL_NOT_ALLOWED');

      const res = await approve(manager.token, po.id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'approved', approvedBy: manager.id, approvalKind: 'approver', approvalReason: null });
    });

    it('counts an Admin with access to all branches, whose role is in another branch, as another approver', async () => {
      const s = await shop();
      const other = (await owner().query(
        `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, 'Other', '-', '{}', '{}') RETURNING id`, [s.tenant],
      )).rows[0].id;
      const admin = await staff(s, 'admin', 'Admin');
      await staff(s, 'head', 'Admin', { branch: other, allBranches: true });
      const po = await submitted(s, admin.token, 1250);
      expect(po.creatorIsOnlyApprover).toBe(false);
      expect((await approve(admin.token, po.id, { reason: 'x' })).body.error).toBe('SELF_APPROVAL_NOT_ALLOWED');
    });

    it('counts neither Super_Admin nor a deactivated Admin as another approver (3a)', async () => {
      const s = await shop();
      const admin = await staff(s, 'admin', 'Admin');
      const superAdmin = await staff(s, 'super', 'Super_Admin', { allBranches: true });
      await staff(s, 'gone', 'Admin', { active: false });
      const po = await submitted(s, admin.token, 1250);
      expect(po.creatorIsOnlyApprover).toBe(true);
      expect((await approve(superAdmin.token, po.id)).status).toBe(403);
    });
  });

  describe('the approval on record (1a)', () => {
    it('records an order approved on submit as approved automatically, under the threshold', async () => {
      const s = await shop();
      const admin = await staff(s, 'admin', 'Admin');
      const po = await submitted(s, admin.token, 400);
      expect(po).toMatchObject({ status: 'approved', approvedBy: admin.id, approvalKind: 'automatic', approvalReason: null, approvalThreshold: 1000 });
      expect(po.approvedAt).toEqual(expect.any(String));
    });

    it('says nothing about approval before submit', async () => {
      const s = await shop();
      const admin = await staff(s, 'admin', 'Admin');
      const created = await as(api().post('/api/v1/purchase-orders'), admin.token).send({
        supplierId: s.supplier, receivingBranchId: s.branch, receivingLocationId: s.location, lineItems: [{ bookId: s.book, quantity: 1, unitCost: 5 }],
      });
      expect(created.body).toMatchObject({ status: 'draft', approvedBy: null, approvedAt: null, approvalKind: null, approvalReason: null });
    });

    it('fills the approval of orders approved before the migration from the audit log, else from who approved them', async () => {
      const migration = createRequire(import.meta.url)('../db/migrations/1700000075_purchase_order_approval.cjs') as {
        up: (pgm: { sql: (s: string) => void }) => void;
      };
      const s = await shop();
      const admin = await staff(s, 'admin', 'Admin');
      const manager = await staff(s, 'manager', 'Manager');
      const auto = await submitted(s, admin.token, 400);
      const big = await submitted(s, admin.token, 1250);
      await approve(manager.token, big.id);
      const client = await owner().connect();
      try {
        await client.query('BEGIN');
        // As the orders were before the migration: no kind, no date.
        await client.query(`UPDATE purchase_orders SET approval_kind = NULL, approved_at = NULL WHERE tenant_id = $1`, [s.tenant]);
        const statements: string[] = [];
        migration.up({ sql: (x) => statements.push(x) });
        for (const x of statements.filter((x) => !/ALTER TABLE/i.test(x))) await client.query(x);
        const rows = (await client.query(
          `SELECT id::text, approval_kind, approved_at IS NOT NULL AS dated FROM purchase_orders WHERE tenant_id = $1 ORDER BY id`, [s.tenant],
        )).rows;
        expect(rows).toEqual([
          { id: auto.id, approval_kind: 'automatic', dated: true },
          { id: big.id, approval_kind: 'approver', dated: true },
        ]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });
});
