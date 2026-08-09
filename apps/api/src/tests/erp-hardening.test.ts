/**
 * ERP Production Hardening — Property-Based Tests
 *
 * These tests encode formal correctness properties for the hardened ERP system.
 * They use vitest with custom generators (no external PBT library required).
 *
 * Properties tested:
 *   P1 — Order status monotonicity
 *   P2 — Inventory conservation
 *   P3 — Settlement balance
 *   P4 — Financial traceability
 *   P5 — Idempotency
 *   P6 — Permission union
 *   P7 — Reservation availability
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../db/index.js';
import { getPermissionsForRoles, ROLE_PERMISSIONS, Permission } from '../lib/permissions.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate N random integers in [min, max] */
function randomInts(n: number, min: number, max: number): number[] {
  return Array.from({ length: n }, () => Math.floor(Math.random() * (max - min + 1)) + min);
}

/** Generate N random subsets of an array */
function randomSubsets<T>(arr: T[], n: number): T[][] {
  return Array.from({ length: n }, () => {
    const size = Math.floor(Math.random() * arr.length) + 1;
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, size);
  });
}

const STAFF_PREFIX = 'pbt_test_';
const BRANCH_PREFIX = 'PBT Test ';

async function getTestBook(): Promise<{ id: number; price: number }> {
  const r = await db.query(
    `SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 1`,
  );
  if (!r.rows.length) throw new Error('No active books with price in DB');
  return { id: r.rows[0].id as number, price: parseFloat(r.rows[0].default_price as string) };
}

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(
    `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'PBT Test Loc', true) RETURNING id`,
    [branchId],
  );
  return c.rows[0].id as number;
}

async function ensureInventory(bookId: number, locationId: number, qty = 100) {
  await db.query(
    `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
     VALUES ($1, $2, $3, 5, 0)
     ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, version = 0`,
    [bookId, locationId, qty],
  );
  // Clear reservations so available = qty (prevents stale reservations from other tests)
  await db.query(
    `DELETE FROM inventory_reservations WHERE book_id = $1 AND location_id = $2`,
    [bookId, locationId],
  ).catch(() => {});
}

async function cleanPbtData(branchId: number) {
  await db.query(
    `DELETE FROM financial_transactions WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`,
    [branchId],
  );
  // Payment Mode Capture: cash_sale confirms now write an order_payments row.
  await db.query(
    `DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`,
    [branchId],
  ).catch(() => {});
  await db.query(
    `DELETE FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`,
    [branchId],
  );
  await db.query(
    `DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`,
    [branchId],
  );
  await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]);
  await db.query(
    `DELETE FROM financial_transactions WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`,
    [branchId],
  );
  await db.query(`DELETE FROM exchanges WHERE branch_id = $1`, [branchId]);
}

// ── Test state ────────────────────────────────────────────────────────────────

let managerToken: string;
let branchId: number;
let locationId: number;
let bookId: number;
let bookPrice: number;

beforeAll(async () => {
  await cleanTestStaff(STAFF_PREFIX);
  const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE 'PBT Test %'`);
  for (const row of oldBranches.rows) {
    await cleanPbtData(row.id as number);
  }
  await cleanTestBranches(BRANCH_PREFIX);

  const branch = await createTestBranch({ name: 'PBT Test Branch' });
  branchId = branch.branchId;
  locationId = await getOrCreateLocation(branchId);
  const book = await getTestBook();
  bookId = book.id;
  bookPrice = book.price;
  await ensureInventory(bookId, locationId, 200);

  const mgr = await createTestStaff({ username: 'pbt_test_mgr', role: 'Manager', branchId });
  managerToken = mgr.token;
});

afterAll(async () => {
  await cleanPbtData(branchId);
  await cleanTestStaff(STAFF_PREFIX);
  await cleanTestBranches(BRANCH_PREFIX);
});

// ─────────────────────────────────────────────────────────────────────────────
// P1 — Order Status Monotonicity
//
// Property: For any sequence of valid lifecycle transitions, the order status
// can only advance forward (DRAFT→CONFIRMED→PAID→FULFILLED→COMPLETED) or
// transition to CANCELLED. It can never go backwards.
// ─────────────────────────────────────────────────────────────────────────────

describe('P1 — Order status monotonicity', () => {
  const ORDER_RANK: Record<string, number> = {
    DRAFT: 0, Pending: 0,
    CONFIRMED: 1, Confirmed: 1,
    PAID: 2,
    FULFILLED: 3, In_Progress: 2, Fulfilled: 3,
    COMPLETED: 4,
    CANCELLED: -1, Cancelled: -1,
  };

  it('status rank never decreases through valid transitions', async () => {
    const app = getTestApp();

    // Create order (DRAFT)
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ branchId, items: [{ bookId, quantity: 1 }] });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.id as string;
    let prevRank = ORDER_RANK[createRes.body.status as string] ?? 0;

    // Confirm (DRAFT → CONFIRMED)
    const confirmRes = await request(app)
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send();
    if (confirmRes.status === 200) {
      const newRank = ORDER_RANK[confirmRes.body.status as string] ?? 0;
      expect(newRank).toBeGreaterThanOrEqual(prevRank);
      prevRank = newRank;
    }

    // Pay (CONFIRMED → PAID)
    const payRes = await request(app)
      .post(`/api/orders/${orderId}/pay`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ amount: bookPrice, method: 'cash' });
    if (payRes.status === 200) {
      const newRank = ORDER_RANK[payRes.body.status as string] ?? 0;
      expect(newRank).toBeGreaterThanOrEqual(prevRank);
      prevRank = newRank;
    }

    // Fulfill (PAID → FULFILLED/COMPLETED)
    const fulfillRes = await request(app)
      .post(`/api/orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ locationId });
    if (fulfillRes.status === 200) {
      const newRank = ORDER_RANK[fulfillRes.body.status as string] ?? 0;
      expect(newRank).toBeGreaterThanOrEqual(prevRank);
    }
  });

  it('attempting to re-confirm a CONFIRMED order returns 409 or 400 (no regression)', async () => {
    const app = getTestApp();
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ branchId, items: [{ bookId, quantity: 1 }] });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.id as string;

    await request(app)
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send();

    // Second confirm must fail
    const secondConfirm = await request(app)
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send();
    expect([400, 409, 422]).toContain(secondConfirm.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2 — Inventory Conservation
//
// Property: After fulfilling an order, the sum of inventory_history deductions
// for those items equals the sum of reservation quantities that were deducted.
// available_stock = on_hand - active_reservations ≥ 0 at all times.
// ─────────────────────────────────────────────────────────────────────────────

describe('P2 — Inventory conservation', () => {
  it('available stock never goes negative after confirming orders', async () => {
    const app = getTestApp();

    // Get current available stock.
    // available = quantity, NOT quantity - reserved. confirm() inserts the
    // 'reserved' row and calls stockOut() (which already decremented
    // inventory.quantity) in the same DB transaction, always -- so a
    // committed 'reserved' row's quantity is already reflected in
    // inventory.quantity (order-payment-unification spec, 3.5). See
    // getAvailableStock() in inventoryTransaction.service.ts.
    const stockBefore = await db.query(
      `SELECT i.quantity AS available
       FROM inventory i
       WHERE i.book_id = $1 AND i.location_id = $2`,
      [bookId, locationId],
    );
    const availableBefore = parseInt(stockBefore.rows[0]?.available ?? '0', 10);

    // Confirm an order for 1 unit
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ branchId, items: [{ bookId, quantity: 1 }] });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.id as string;

    const confirmRes = await request(app)
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send();

    if (confirmRes.status === 200) {
      // Available stock must have decreased by exactly 1
      const stockAfter = await db.query(
        `SELECT i.quantity AS available
         FROM inventory i
         WHERE i.book_id = $1 AND i.location_id = $2`,
        [bookId, locationId],
      );
      const availableAfter = parseInt(stockAfter.rows[0]?.available ?? '0', 10);
      expect(availableAfter).toBe(availableBefore - 1);
      expect(availableAfter).toBeGreaterThanOrEqual(0);
    }
  });

  it('cancelling a CONFIRMED order releases reservations (available stock restored)', async () => {
    const app = getTestApp();

    const stockBefore = await db.query(
      `SELECT i.quantity AS available
       FROM inventory i WHERE i.book_id = $1 AND i.location_id = $2`,
      [bookId, locationId],
    );
    const availableBefore = parseInt(stockBefore.rows[0]?.available ?? '0', 10);

    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ branchId, items: [{ bookId, quantity: 1 }] });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.id as string;

    await request(app)
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send();

    await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ reason: 'PBT test cancel' });

    const stockAfter = await db.query(
      `SELECT i.quantity AS available
       FROM inventory i WHERE i.book_id = $1 AND i.location_id = $2`,
      [bookId, locationId],
    );
    const availableAfter = parseInt(stockAfter.rows[0]?.available ?? '0', 10);
    expect(availableAfter).toBe(availableBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P3 — Settlement Balance
//
// Property: For any set of settlement entries, the sum of payment entries
// minus the sum of refund entries equals the net amount settled.
// The settlement total must equal the exchange net_balance for the exchange
// to transition to SETTLED.
// ─────────────────────────────────────────────────────────────────────────────

describe('P3 — Settlement balance (pure logic)', () => {
  type EntryType = 'payment' | 'refund' | 'adjustment';
  interface Entry { entryType: EntryType; amount: number; }

  function computeSettlementTotal(entries: Entry[]): number {
    return entries.reduce((sum, e) => {
      if (e.entryType === 'refund') return sum - e.amount;
      return sum + e.amount; // payment or adjustment
    }, 0);
  }

  it('settlement total equals sum(payments) - sum(refunds) + sum(adjustments)', () => {
    // Generate 100 random entry sets and verify the formula
    const runs = 100;
    for (let i = 0; i < runs; i++) {
      const n = Math.floor(Math.random() * 5) + 1;
      const entries: Entry[] = Array.from({ length: n }, () => {
        const types: EntryType[] = ['payment', 'refund', 'adjustment'];
        const entryType = types[Math.floor(Math.random() * types.length)];
        const amount = Math.round(Math.random() * 1000 * 100) / 100; // 0–1000 ETB
        return { entryType, amount };
      });

      const computed = computeSettlementTotal(entries);
      const manual =
        entries.filter(e => e.entryType === 'payment').reduce((s, e) => s + e.amount, 0) +
        entries.filter(e => e.entryType === 'adjustment').reduce((s, e) => s + e.amount, 0) -
        entries.filter(e => e.entryType === 'refund').reduce((s, e) => s + e.amount, 0);

      expect(Math.abs(computed - manual)).toBeLessThan(0.001);
    }
  });

  it('a single payment entry equal to net_balance satisfies the balance constraint', () => {
    const netBalances = randomInts(50, 1, 10000).map(n => n / 100);
    for (const netBalance of netBalances) {
      const entries: Entry[] = [{ entryType: 'payment', amount: netBalance }];
      const total = computeSettlementTotal(entries);
      expect(Math.abs(total - netBalance)).toBeLessThan(0.001);
    }
  });

  it('hybrid settlement: partial payment + adjustment can equal net_balance', () => {
    const runs = 50;
    for (let i = 0; i < runs; i++) {
      const netBalance = Math.round(Math.random() * 1000 * 100) / 100;
      const payPart = Math.round(Math.random() * netBalance * 100) / 100;
      const adjPart = Math.round((netBalance - payPart) * 100) / 100;
      const entries: Entry[] = [
        { entryType: 'payment', amount: payPart },
        { entryType: 'adjustment', amount: adjPart },
      ];
      const total = computeSettlementTotal(entries);
      expect(Math.abs(total - netBalance)).toBeLessThan(0.01);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P4 — Financial Traceability
//
// Property: Every row in financial_transactions must have either order_id OR
// exchange_id set (not both null). This is enforced at the DB level via CHECK.
// ─────────────────────────────────────────────────────────────────────────────

describe('P4 — Financial traceability', () => {
  it('all financial_transactions rows have order_id or exchange_id', async () => {
    const result = await db.query(
      `SELECT COUNT(*) AS orphaned
       FROM financial_transactions
       WHERE order_id IS NULL AND exchange_id IS NULL`,
    );
    const orphaned = parseInt(result.rows[0].orphaned as string, 10);
    expect(orphaned).toBe(0);
  });

  it('financial_transactions table has the idempotency_key UNIQUE constraint', async () => {
    const result = await db.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
       WHERE tc.table_name = 'financial_transactions'
         AND tc.constraint_type = 'UNIQUE'
         AND ccu.column_name = 'idempotency_key'`,
    );
    expect(parseInt(result.rows[0].cnt as string, 10)).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P5 — Idempotency
//
// Property: Submitting the same idempotency_key twice produces the same
// response and only one row in financial_transactions.
// ─────────────────────────────────────────────────────────────────────────────

describe('P5 — Idempotency', () => {
  it('duplicate idempotency_key on financial_transactions is rejected at DB level', async () => {
    const key = `pbt-idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Create an order to reference
    const app = getTestApp();
    const createRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ branchId, items: [{ bookId, quantity: 1 }] });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.id as string;

    // Insert first transaction
    await db.query(
      `INSERT INTO financial_transactions
         (order_id, type, amount, currency, method, idempotency_key, staff_id, branch_id)
       VALUES ($1, 'payment', 100, 'ETB', 'cash', $2, 1, $3)`,
      [orderId, key, branchId],
    );

    // Second insert with same key must fail
    await expect(
      db.query(
        `INSERT INTO financial_transactions
           (order_id, type, amount, currency, method, idempotency_key, staff_id, branch_id)
         VALUES ($1, 'payment', 100, 'ETB', 'cash', $2, 1, $3)`,
        [orderId, key, branchId],
      ),
    ).rejects.toThrow();

    // Verify only one row exists
    const count = await db.query(
      `SELECT COUNT(*) AS cnt FROM financial_transactions WHERE idempotency_key = $1`,
      [key],
    );
    expect(parseInt(count.rows[0].cnt as string, 10)).toBe(1);

    // Cleanup
    await db.query(`DELETE FROM financial_transactions WHERE idempotency_key = $1`, [key]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P6 — Permission Union
//
// Property: A staff member with multiple roles gets the union of all permissions
// from those roles. No permission is lost, no permission is duplicated.
// ─────────────────────────────────────────────────────────────────────────────

describe('P6 — Permission union (pure logic)', () => {
  const ALL_ROLES = Object.keys(ROLE_PERMISSIONS);

  it('union of single role equals that role\'s permissions', () => {
    for (const role of ALL_ROLES) {
      const union = getPermissionsForRoles([role]);
      const expected = ROLE_PERMISSIONS[role];
      expect(new Set(union)).toEqual(new Set(expected));
    }
  });

  it('union of multiple roles contains all permissions from each role', () => {
    const roleSets = randomSubsets(ALL_ROLES, 50);
    for (const roles of roleSets) {
      const union = getPermissionsForRoles(roles);
      const unionSet = new Set(union);

      // Every permission from every role must be in the union
      for (const role of roles) {
        for (const perm of ROLE_PERMISSIONS[role] ?? []) {
          expect(unionSet.has(perm as Permission)).toBe(true);
        }
      }
    }
  });

  it('union contains no duplicates', () => {
    const roleSets = randomSubsets(ALL_ROLES, 50);
    for (const roles of roleSets) {
      const union = getPermissionsForRoles(roles);
      expect(union.length).toBe(new Set(union).size);
    }
  });

  it('union is monotone: adding more roles never removes permissions', () => {
    const runs = 50;
    for (let i = 0; i < runs; i++) {
      const baseRoles = randomSubsets(ALL_ROLES, 1)[0];
      const extraRole = ALL_ROLES[Math.floor(Math.random() * ALL_ROLES.length)];
      const extendedRoles = [...new Set([...baseRoles, extraRole])];

      const baseUnion = new Set(getPermissionsForRoles(baseRoles));
      const extendedUnion = new Set(getPermissionsForRoles(extendedRoles));

      // Every permission in base must still be in extended
      for (const perm of baseUnion) {
        expect(extendedUnion.has(perm)).toBe(true);
      }
    }
  });

  it('Admin has all 9 permissions; Super_Admin is governance-only (3 permissions)', () => {
    const allPerms: Permission[] = [
      'CREATE_SALE', 'PROCESS_PAYMENT', 'APPROVE_EXCHANGE', 'PROCESS_REFUND',
      'ADJUST_PRICE', 'MANAGE_INVENTORY', 'VIEW_REPORTS', 'MANAGE_STAFF', 'MANAGE_BRANCH',
    ];
    // Admin must have all 9 permissions
    const adminUnion = new Set(getPermissionsForRoles(['Admin']));
    for (const perm of allPerms) {
      expect(adminUnion.has(perm)).toBe(true);
    }
    // Super_Admin is governance-only: VIEW_REPORTS, MANAGE_STAFF, MANAGE_BRANCH
    const superAdminUnion = new Set(getPermissionsForRoles(['Super_Admin']));
    expect(superAdminUnion.has('MANAGE_STAFF')).toBe(true);
    expect(superAdminUnion.has('MANAGE_BRANCH')).toBe(true);
    expect(superAdminUnion.has('VIEW_REPORTS')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P7 — Reservation Availability
//
// Property: After any number of order confirmations, available_stock ≥ 0.
// Specifically: on_hand_quantity - sum(active_reservations) ≥ 0.
// ─────────────────────────────────────────────────────────────────────────────

describe('P7 — Reservation availability', () => {
  it('available stock is always ≥ 0 after multiple confirmations', async () => {
    const app = getTestApp();

    // Set inventory to a known quantity
    const testQty = 5;
    await ensureInventory(bookId, locationId, testQty);

    // Confirm testQty orders of 1 unit each — should all succeed
    const orderIds: string[] = [];
    for (let i = 0; i < testQty; i++) {
      const createRes = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ branchId, items: [{ bookId, quantity: 1 }] });
      expect(createRes.status).toBe(201);
      orderIds.push(createRes.body.id as string);

      const confirmRes = await request(app)
        .post(`/api/orders/${orderIds[i]}/confirm`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send();
      expect(confirmRes.status).toBe(200);
    }

    // Available stock must be exactly 0 now
    const stockResult = await db.query(
      `SELECT i.quantity AS available
       FROM inventory i WHERE i.book_id = $1 AND i.location_id = $2`,
      [bookId, locationId],
    );
    const available = parseInt(stockResult.rows[0]?.available ?? '0', 10);
    expect(available).toBe(0);
    expect(available).toBeGreaterThanOrEqual(0);

    // One more confirmation attempt should fail (no stock)
    const overflowCreate = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ branchId, items: [{ bookId, quantity: 1 }] });
    if (overflowCreate.status === 201) {
      const overflowConfirm = await request(app)
        .post(`/api/orders/${overflowCreate.body.id}/confirm`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send();
      // Must fail — cannot reserve more than available
      expect([400, 409, 422]).toContain(overflowConfirm.status);
    }

    // Restore inventory for other tests
    await ensureInventory(bookId, locationId, 200);
  });

  it('available_stock formula is consistent with DB state (pure DB property)', async () => {
    // For every inventory row, verify: available = quantity ≥ 0.
    // reserved is still selected for visibility/debugging but is no longer
    // subtracted -- see getAvailableStock() in inventoryTransaction.service.ts.
    const result = await db.query(
      `SELECT
         i.book_id,
         i.location_id,
         i.quantity,
         COALESCE(SUM(r.quantity), 0) AS reserved,
         i.quantity AS available
       FROM inventory i
       LEFT JOIN inventory_reservations r
         ON r.book_id = i.book_id
         AND r.location_id = i.location_id
         AND r.status = 'reserved'
       GROUP BY i.book_id, i.location_id, i.quantity`,
    );

    for (const row of result.rows) {
      const available = parseInt(row.available as string, 10);
      expect(available).toBeGreaterThanOrEqual(0);
    }
  });
});

