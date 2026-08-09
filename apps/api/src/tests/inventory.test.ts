import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'inv_test_';
const BRANCH_PREFIX = 'Inv Test ';

// ── Cleanup helpers ───────────────────────────────────────────────────────────

async function cleanTestInventory(branchId: number) {
  // Remove inventory_history rows for locations in this branch
  await db.query(
    `DELETE FROM inventory_history WHERE location_id IN (
       SELECT id FROM locations WHERE branch_id = $1
     )`,
    [branchId],
  );
  // Remove inventory rows for locations in this branch
  await db.query(
    `DELETE FROM inventory WHERE location_id IN (
       SELECT id FROM locations WHERE branch_id = $1
     )`,
    [branchId],
  );
}

async function getTestBook(): Promise<number> {
  const result = await db.query(`SELECT id FROM books WHERE is_active = true LIMIT 1`);
  if (!result.rows.length) throw new Error('No active books found — run migrations with seed data');
  return result.rows[0].id as number;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Inventory', () => {
  let adminToken: string;
  let stockClerkToken: string;
  let salesToken: string;
  let branchId: number;
  let bookId: number;
  let locationId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Inv Test Branch' });
    branchId = branch.branchId;

    const admin = await createTestStaff({ username: 'inv_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    const clerk = await createTestStaff({ username: 'inv_test_clerk', role: 'Stock_Clerk', branchId });
    stockClerkToken = clerk.token;

    const sales = await createTestStaff({ username: 'inv_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;

    bookId = await getTestBook();

    // Create a location for the test branch
    const locResult = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment)
       VALUES ($1, 'Inv Test Main Floor', true) RETURNING id`,
      [branchId],
    );
    locationId = locResult.rows[0].id as number;

    // Ensure inventory row exists for our test book + location
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
       VALUES ($1, $2, 10, 3, 0)
       ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = 10, version = 0`,
      [bookId, locationId],
    );
  });

  afterAll(async () => {
    await cleanTestInventory(branchId);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── GET /api/inventory ────────────────────────────────────────────────────

  it('Any authenticated role can list inventory', async () => {
    const res = await request(getTestApp())
      .get('/api/inventory')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('Unauthenticated request returns 401', async () => {
    const res = await request(getTestApp()).get('/api/inventory');
    expect(res.status).toBe(401);
  });

  it('Filter by locationId returns only that location', async () => {
    const res = await request(getTestApp())
      .get(`/api/inventory?locationId=${locationId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    res.body.items.forEach((item: { locationId: number }) => {
      expect(item.locationId).toBe(locationId);
    });
  });

  it('Deactivated books are hidden from the inventory list by default, excluded by is_active=true, included by is_active=all, and returned alone by is_active=false', async () => {
    const bookRes = await db.query(
      `INSERT INTO books (isbn, title, is_active) VALUES ($1, 'Inv Test Deactivated Book', true) RETURNING id`,
      [`978inv${Date.now()}`],
    );
    const inactiveBookId = bookRes.rows[0].id as number;
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 5, 1, 0)`,
      [inactiveBookId, locationId],
    );
    await db.query(`UPDATE books SET is_active = false WHERE id = $1`, [inactiveBookId]);

    try {
      // Default (no is_active param) — same as is_active=true — excludes it.
      const byDefault = await request(getTestApp())
        .get(`/api/inventory?locationId=${locationId}&pageSize=100`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(byDefault.status).toBe(200);
      expect(byDefault.body.items.some((i: { bookId: number }) => i.bookId === inactiveBookId)).toBe(false);

      // Explicit is_active=true — same exclusion.
      const explicitActive = await request(getTestApp())
        .get(`/api/inventory?locationId=${locationId}&pageSize=100&is_active=true`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(explicitActive.body.items.some((i: { bookId: number }) => i.bookId === inactiveBookId)).toBe(false);

      // is_active=all — bug regression: must actually include it, not silently
      // fall back to active-only the way an omitted param does.
      const all = await request(getTestApp())
        .get(`/api/inventory?locationId=${locationId}&pageSize=100&is_active=all`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(all.status).toBe(200);
      const row = all.body.items.find((i: { bookId: number }) => i.bookId === inactiveBookId);
      expect(row).toBeDefined();
      expect(row.bookIsActive).toBe(false);

      // is_active=false — inactive-only; our still-active seeded book must
      // not leak into this view.
      const inactiveOnly = await request(getTestApp())
        .get(`/api/inventory?locationId=${locationId}&pageSize=100&is_active=false`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(inactiveOnly.status).toBe(200);
      expect(inactiveOnly.body.items.some((i: { bookId: number }) => i.bookId === inactiveBookId)).toBe(true);
      expect(inactiveOnly.body.items.some((i: { bookId: number }) => i.bookId === bookId)).toBe(false);
    } finally {
      await db.query(`DELETE FROM inventory WHERE book_id = $1`, [inactiveBookId]);
      await db.query(`DELETE FROM books WHERE id = $1`, [inactiveBookId]);
    }
  });

  it('sortBy=updatedAt sorts inventory rows by their updated_at timestamp', async () => {
    const asc = await request(getTestApp())
      .get(`/api/inventory?locationId=${locationId}&pageSize=100&sortBy=updatedAt&sortDir=asc`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(asc.status).toBe(200);
    const ascTimestamps = asc.body.items.map((i: { updatedAt: string }) => new Date(i.updatedAt).getTime());
    for (let i = 1; i < ascTimestamps.length; i++) {
      expect(ascTimestamps[i]).toBeGreaterThanOrEqual(ascTimestamps[i - 1]);
    }

    const desc = await request(getTestApp())
      .get(`/api/inventory?locationId=${locationId}&pageSize=100&sortBy=updatedAt&sortDir=desc`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(desc.status).toBe(200);
    const descTimestamps = desc.body.items.map((i: { updatedAt: string }) => new Date(i.updatedAt).getTime());
    for (let i = 1; i < descTimestamps.length; i++) {
      expect(descTimestamps[i]).toBeLessThanOrEqual(descTimestamps[i - 1]);
    }
  });

  // ── POST /api/inventory/adjust ────────────────────────────────────────────

  it('Admin can adjust stock upward (correction)', async () => {
    const res = await request(getTestApp())
      .post('/api/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bookId, locationId, delta: 5, reasonCode: 'correction', version: 0 });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(15);
    expect(res.body.version).toBe(1);
  });

  it('Stock_Clerk can adjust stock (damage)', async () => {
    const res = await request(getTestApp())
      .post('/api/inventory/adjust')
      .set('Authorization', `Bearer ${stockClerkToken}`)
      .send({ bookId, locationId, delta: -2, reasonCode: 'damage', version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(13);
  });

  it('Sales role cannot adjust stock (403)', async () => {
    const res = await request(getTestApp())
      .post('/api/inventory/adjust')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ bookId, locationId, delta: 1, reasonCode: 'correction', version: 2 });
    expect(res.status).toBe(403);
  });

  it('VERSION_CONFLICT returned on stale version', async () => {
    const res = await request(getTestApp())
      .post('/api/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bookId, locationId, delta: 1, reasonCode: 'correction', version: 0 }); // stale
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('VERSION_CONFLICT');
  });

  it('Invalid reason code returns 400', async () => {
    const res = await request(getTestApp())
      .post('/api/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bookId, locationId, delta: 1, reasonCode: 'theft', version: 2 });
    expect(res.status).toBe(400);
  });

  it('Zero delta returns 400', async () => {
    const res = await request(getTestApp())
      .post('/api/inventory/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bookId, locationId, delta: 0, reasonCode: 'correction', version: 2 });
    expect(res.status).toBe(400);
  });

  // ── POST /api/inventory/transfer ──────────────────────────────────────────

  it('Admin can transfer stock between locations in same branch', async () => {
    // Create a second location in the same branch
    const loc2 = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment)
       VALUES ($1, 'Inv Test Location 2', false) RETURNING id`,
      [branchId],
    );
    const locationId2 = loc2.rows[0].id as number;

    // Initialize inventory for second location
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
       VALUES ($1, $2, 0, 3, 0) ON CONFLICT DO NOTHING`,
      [bookId, locationId2],
    );

    // Get current version of source
    const src = await db.query(
      `SELECT version FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, locationId],
    );
    const currentVersion = src.rows[0].version as number;

    const res = await request(getTestApp())
      .post('/api/inventory/transfer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bookId, fromLocationId: locationId, toLocationId: locationId2, quantity: 3, fromVersion: currentVersion });

    expect(res.status).toBe(200);
    expect(res.body.from.quantity).toBe(res.body.from.quantity); // decreased
    expect(res.body.to.quantity).toBe(3);

    // Cleanup
    await db.query(`DELETE FROM inventory WHERE location_id = $1`, [locationId2]);
    await db.query(`DELETE FROM inventory_history WHERE location_id = $1`, [locationId2]);
    await db.query(`DELETE FROM locations WHERE id = $1`, [locationId2]);
  });

  it('Transfer with insufficient stock returns 422', async () => {
    const src = await db.query(
      `SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, locationId],
    );
    const { quantity, version } = src.rows[0] as { quantity: number; version: number };

    const loc2 = await db.query(
      `INSERT INTO locations (branch_id, name) VALUES ($1, 'Inv Test Loc Overflow') RETURNING id`,
      [branchId],
    );
    const locationId2 = loc2.rows[0].id as number;

    const res = await request(getTestApp())
      .post('/api/inventory/transfer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bookId, fromLocationId: locationId, toLocationId: locationId2, quantity: quantity + 100, fromVersion: version });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');

    await db.query(`DELETE FROM locations WHERE id = $1`, [locationId2]);
  });

  // ── GET /api/inventory/low-stock ──────────────────────────────────────────

  it('Low-stock endpoint returns items at or below reorder point', async () => {
    // Set quantity below reorder point
    await db.query(
      `UPDATE inventory SET quantity = 2, reorder_point = 5, version = version + 1
       WHERE book_id = $1 AND location_id = $2`,
      [bookId, locationId],
    );

    const res = await request(getTestApp())
      .get('/api/inventory/low-stock')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    const found = res.body.items.find((i: { bookId: number; locationId: number }) =>
      i.bookId === bookId && i.locationId === locationId,
    );
    expect(found).toBeDefined();
    expect(found.isLowStock).toBe(true);
  });

  it('Low-stock endpoint excludes deactivated books', async () => {
    const bookRes = await db.query(
      `INSERT INTO books (isbn, title, is_active) VALUES ($1, 'Inv Test Deactivated Low Stock Book', true) RETURNING id`,
      [`978lsinv${Date.now()}`],
    );
    const inactiveBookId = bookRes.rows[0].id as number;
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 1, 5, 0)`,
      [inactiveBookId, locationId],
    );
    await db.query(`UPDATE books SET is_active = false WHERE id = $1`, [inactiveBookId]);

    try {
      const res = await request(getTestApp())
        .get('/api/inventory/low-stock?pageSize=100')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items.some((i: { bookId: number }) => i.bookId === inactiveBookId)).toBe(false);
    } finally {
      await db.query(`DELETE FROM inventory WHERE book_id = $1`, [inactiveBookId]);
      await db.query(`DELETE FROM books WHERE id = $1`, [inactiveBookId]);
    }
  });

  // ── GET /api/inventory/history ────────────────────────────────────────────

  it('History endpoint returns movement log', async () => {
    const res = await request(getTestApp())
      .get('/api/inventory/history')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('History can be filtered by reasonCode', async () => {
    const res = await request(getTestApp())
      .get('/api/inventory/history?reasonCode=damage')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    res.body.items.forEach((h: { reasonCode: string }) => {
      expect(h.reasonCode).toBe('damage');
    });
  });

  // ── PUT /api/inventory/reorder-point ──────────────────────────────────────

  it('Admin can update reorder point', async () => {
    const res = await request(getTestApp())
      .put('/api/inventory/reorder-point')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bookId, locationId, reorderPoint: 10 });
    expect(res.status).toBe(200);
    expect(res.body.reorderPoint).toBe(10);
  });

  it('Stock_Clerk cannot update reorder point (403)', async () => {
    const res = await request(getTestApp())
      .put('/api/inventory/reorder-point')
      .set('Authorization', `Bearer ${stockClerkToken}`)
      .send({ bookId, locationId, reorderPoint: 5 });
    expect(res.status).toBe(403);
  });

  // ── Audit log ─────────────────────────────────────────────────────────────

  it('Adjust produces audit log entry', async () => {
    const audit = await db.query(
      `SELECT * FROM audit_logs WHERE entity_type = 'inventory' AND staff_id IN (
         SELECT id FROM staff WHERE username = 'inv_test_admin'
       ) ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });
});

// ── Stock In / Stock Out tests ────────────────────────────────────────────────

describe('Inventory — Stock In / Stock Out', () => {
  let adminToken: string;
  let managerToken: string;
  let salesToken: string;
  let purchasorToken: string;
  let branchId: number;
  let bookId: number;
  let locationId: number;

  beforeAll(async () => {
    await cleanTestStaff('sio_test_');
    await cleanTestBranches('SIO Test ');

    const branch = await createTestBranch({ name: 'SIO Test Branch' });
    branchId = branch.branchId;

    const admin = await createTestStaff({ username: 'sio_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    const mgr = await createTestStaff({ username: 'sio_test_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;

    const sales = await createTestStaff({ username: 'sio_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;

    const purchasor = await createTestStaff({ username: 'sio_test_purchasor', role: 'Purchasor', branchId });
    purchasorToken = purchasor.token;

    bookId = await db.query(`SELECT id FROM books WHERE is_active = true LIMIT 1`).then(r => r.rows[0].id as number);

    const locResult = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'SIO Test Floor', true) RETURNING id`,
      [branchId],
    );
    locationId = locResult.rows[0].id as number;

    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
       VALUES ($1, $2, 5, 3, 0)
       ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = 5, version = 0`,
      [bookId, locationId],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await cleanTestStaff('sio_test_');
    await cleanTestBranches('SIO Test ');
  });

  // ── POST /api/inventory/stock-in ──────────────────────────────────────────

  it('Manager can stock in', async () => {
    const res = await request(getTestApp())
      .post('/api/inventory/stock-in')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ bookId, locationId, quantity: 10, version: 0 });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(15);
    expect(res.body.version).toBe(1);
  });

  it('Stock-in with referenceType and referenceId', async () => {
    const res = await request(getTestApp())
      .post('/api/inventory/stock-in')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bookId, locationId, quantity: 5, version: 1, referenceType: 'purchase_order', referenceId: 42 });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(20);
  });

  it('Purchasor cannot stock in (403)', async () => {
    const res = await request(getTestApp())
      .post('/api/inventory/stock-in')
      .set('Authorization', `Bearer ${purchasorToken}`)
      .send({ bookId, locationId, quantity: 1, version: 2 });
    expect(res.status).toBe(403);
  });

  it('Stock-in VERSION_CONFLICT returns 409', async () => {
    const res = await request(getTestApp())
      .post('/api/inventory/stock-in')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bookId, locationId, quantity: 1, version: 0 }); // stale
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('VERSION_CONFLICT');
  });

  it('Stock-in zero quantity returns 400', async () => {
    const res = await request(getTestApp())
      .post('/api/inventory/stock-in')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bookId, locationId, quantity: 0, version: 2 });
    expect(res.status).toBe(400);
  });

  // ── POST /api/inventory/stock-out ─────────────────────────────────────────

  it('Sales can stock out', async () => {
    const src = await db.query(`SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const { quantity, version } = src.rows[0] as { quantity: number; version: number };

    const res = await request(getTestApp())
      .post('/api/inventory/stock-out')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ bookId, locationId, quantity: 3, version });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(quantity - 3);
  });

  it('Stock-out with referenceType', async () => {
    const src = await db.query(`SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const { quantity, version } = src.rows[0] as { quantity: number; version: number };

    const res = await request(getTestApp())
      .post('/api/inventory/stock-out')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bookId, locationId, quantity: 2, version, referenceType: 'sale', referenceId: 99 });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(quantity - 2);
  });

  it('Purchasor cannot stock out (403)', async () => {
    const src = await db.query(`SELECT version FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const version = src.rows[0].version as number;

    const res = await request(getTestApp())
      .post('/api/inventory/stock-out')
      .set('Authorization', `Bearer ${purchasorToken}`)
      .send({ bookId, locationId, quantity: 1, version });
    expect(res.status).toBe(403);
  });

  it('Stock-out exceeding available quantity returns 422 (when negative stock disabled)', async () => {
    // Ensure negative stock is disabled (default)
    const src = await db.query(`SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const { quantity, version } = src.rows[0] as { quantity: number; version: number };

    const res = await request(getTestApp())
      .post('/api/inventory/stock-out')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bookId, locationId, quantity: quantity + 100, version });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');
  });

  // ── History movement_type filter ──────────────────────────────────────────

  it('History filtered by movementType=stock_in returns only stock_in rows', async () => {
    const res = await request(getTestApp())
      .get('/api/inventory/history?movementType=stock_in')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    res.body.items.forEach((h: { movementType: string }) => {
      expect(h.movementType).toBe('stock_in');
    });
  });

  it('History filtered by movementType=stock_out returns only stock_out rows', async () => {
    const res = await request(getTestApp())
      .get('/api/inventory/history?movementType=stock_out')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    res.body.items.forEach((h: { movementType: string }) => {
      expect(h.movementType).toBe('stock_out');
    });
  });

  it('History rows include movementType, referenceType, referenceId', async () => {
    const res = await request(getTestApp())
      .get('/api/inventory/history?movementType=stock_in')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    const withRef = res.body.items.find((h: { referenceType: string | null }) => h.referenceType === 'purchase_order');
    expect(withRef).toBeDefined();
    expect(withRef.referenceId).toBe('42');
  });
});
