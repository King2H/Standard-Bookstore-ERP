import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff } from './helpers/testDb.js';
import { createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'sup_test_';

// ── Cleanup helpers ───────────────────────────────────────────────────────────

async function cleanTestSuppliers() {
  await db.query(`DELETE FROM book_suppliers WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE 'Test Supplier%')`);
  await db.query(`DELETE FROM suppliers WHERE name LIKE 'Test Supplier%'`);
}

async function getTestPublisherId(): Promise<number | null> {
  const result = await db.query(`SELECT id FROM publishers LIMIT 1`);
  return result.rows.length ? (result.rows[0].id as number) : null;
}

async function getTestBookId(): Promise<number | null> {
  const result = await db.query(`SELECT id FROM books WHERE is_active = true LIMIT 1`);
  return result.rows.length ? (result.rows[0].id as number) : null;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Supplier Management', () => {
  let adminToken: string;
  let purchasorToken: string;
  let salesToken: string;
  let branchId: number;
  let publisherId: number | null;
  let bookId: number | null;

  beforeAll(async () => {
    // Clean inventory_history rows from any previous test run before removing staff
    await db.query(
      `DELETE FROM inventory_history WHERE staff_id IN (SELECT id FROM staff WHERE username LIKE $1)`,
      [`${STAFF_PREFIX}%`],
    );
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestSuppliers();

    // Use the seeded branch (id=1)
    branchId = 1;

    const admin = await createTestStaff({ username: 'sup_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    const purchasor = await createTestStaff({ username: 'sup_test_purchasor', role: 'Purchasor', branchId });
    purchasorToken = purchasor.token;

    const sales = await createTestStaff({ username: 'sup_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;

    publisherId = await getTestPublisherId();
    bookId = await getTestBookId();
  });

  afterAll(async () => {
    await cleanTestSuppliers();
    // Clean inventory_history rows created by test staff before deleting staff
    await db.query(
      `DELETE FROM inventory_history WHERE staff_id IN (SELECT id FROM staff WHERE username LIKE $1)`,
      [`${STAFF_PREFIX}%`],
    );
    await cleanTestStaff(STAFF_PREFIX);
  });

  // ── Create ──────────────────────────────────────────────────────────────────

  describe('POST /api/suppliers', () => {
    it('creates an external supplier', async () => {
      const res = await request(getTestApp())
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({
          name: 'Test Supplier External',
          contactInfo: { phone: '555-1111', email: 'ext@test.com' },
          leadTimeDays: 5,
          supplierType: 'external',
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Test Supplier External');
      expect(res.body.supplierType).toBe('external');
      expect(res.body.publisherId).toBeNull();
      expect(res.body.isActive).toBe(true);
      expect(res.body.isBlacklisted).toBe(false);
    });

    it('creates a publisher-type supplier when publisher exists', async () => {
      if (!publisherId) {
        console.log('Skipping: no publishers in DB');
        return;
      }

      const res = await request(getTestApp())
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({
          name: 'Test Supplier Publisher',
          contactInfo: { phone: '555-2222', email: 'pub@test.com' },
          leadTimeDays: 14,
          supplierType: 'publisher',
          publisherId,
        });

      expect(res.status).toBe(201);
      expect(res.body.supplierType).toBe('publisher');
      expect(res.body.publisherId).toBe(publisherId);
    });

    it('rejects publisher-type without publisherId (422)', async () => {
      const res = await request(getTestApp())
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({
          name: 'Test Supplier Bad Publisher',
          contactInfo: { phone: '555-3333', email: 'bad@test.com' },
          leadTimeDays: 7,
          supplierType: 'publisher',
          // publisherId intentionally omitted
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('PUBLISHER_ID_REQUIRED');
    });

    it('rejects external-type with publisherId (422)', async () => {
      if (!publisherId) return;

      const res = await request(getTestApp())
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({
          name: 'Test Supplier Bad External',
          contactInfo: { phone: '555-4444', email: 'bad2@test.com' },
          leadTimeDays: 7,
          supplierType: 'external',
          publisherId,
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('PUBLISHER_ID_NOT_ALLOWED');
    });

    it('rejects duplicate name (409)', async () => {
      const res = await request(getTestApp())
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({
          name: 'Test Supplier External',
          contactInfo: { phone: '555-9999', email: 'dup@test.com' },
          leadTimeDays: 7,
          supplierType: 'external',
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('DUPLICATE_SUPPLIER_NAME');
    });

    it('rejects Sales role (403)', async () => {
      const res = await request(getTestApp())
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${salesToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({
          name: 'Test Supplier Sales Attempt',
          contactInfo: { phone: '555-0000', email: 'sales@test.com' },
          leadTimeDays: 7,
          supplierType: 'external',
        });

      expect(res.status).toBe(403);
    });

    it('Purchasor can create a supplier', async () => {
      const res = await request(getTestApp())
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${purchasorToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({
          name: 'Test Supplier By Purchasor',
          contactInfo: { phone: '555-5555', email: 'purchasor@test.com' },
          leadTimeDays: 10,
          supplierType: 'external',
        });

      expect(res.status).toBe(201);
    });
  });

  // ── List ────────────────────────────────────────────────────────────────────

  describe('GET /api/suppliers', () => {
    it('returns paginated supplier list', async () => {
      const res = await request(getTestApp())
        .get('/api/suppliers?pageSize=50')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(typeof res.body.total).toBe('number');
    });

    it('filters by supplierType=external', async () => {
      const res = await request(getTestApp())
        .get('/api/suppliers?supplierType=external')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(200);
      res.body.items.forEach((s: { supplierType: string }) => {
        expect(s.supplierType).toBe('external');
      });
    });

    it('rejects unauthenticated (401)', async () => {
      const res = await request(getTestApp()).get('/api/suppliers');
      expect(res.status).toBe(401);
    });
  });

  // ── Update ──────────────────────────────────────────────────────────────────

  describe('PUT /api/suppliers/:id', () => {
    it('updates supplier name and lead time', async () => {
      // Get the external supplier we created
      const listRes = await request(getTestApp())
        .get('/api/suppliers?q=Test+Supplier+External')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      const supplier = listRes.body.items[0];
      expect(supplier).toBeDefined();

      const res = await request(getTestApp())
        .put(`/api/suppliers/${supplier.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ leadTimeDays: 3 });

      expect(res.status).toBe(200);
      expect(res.body.leadTimeDays).toBe(3);
    });
  });

  // ── Deactivate ──────────────────────────────────────────────────────────────

  describe('POST /api/suppliers/:id/deactivate', () => {
    it('deactivates a supplier', async () => {
      const listRes = await request(getTestApp())
        .get('/api/suppliers?q=Test+Supplier+By+Purchasor')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      const supplier = listRes.body.items[0];
      expect(supplier).toBeDefined();

      const res = await request(getTestApp())
        .post(`/api/suppliers/${supplier.id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(200);

      // Verify is_active = false
      const getRes = await request(getTestApp())
        .get(`/api/suppliers/${supplier.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(getRes.body.isActive).toBe(false);
    });
  });

  // ── Blacklist ───────────────────────────────────────────────────────────────

  describe('POST /api/suppliers/:id/blacklist', () => {
    it('blacklists a supplier (Admin only)', async () => {
      const listRes = await request(getTestApp())
        .get('/api/suppliers?q=Test+Supplier+External')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      const supplier = listRes.body.items[0];
      expect(supplier).toBeDefined();

      const res = await request(getTestApp())
        .post(`/api/suppliers/${supplier.id}/blacklist`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(200);

      const getRes = await request(getTestApp())
        .get(`/api/suppliers/${supplier.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(getRes.body.isBlacklisted).toBe(true);
    });

    it('rejects Purchasor from blacklisting (403)', async () => {
      const listRes = await request(getTestApp())
        .get('/api/suppliers?q=Test+Supplier+External')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      const supplier = listRes.body.items[0];

      const res = await request(getTestApp())
        .post(`/api/suppliers/${supplier.id}/blacklist`)
        .set('Authorization', `Bearer ${purchasorToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(403);
    });
  });

  // ── validateSupplierForProcurement (service-level) ──────────────────────────

  describe('validateSupplierForProcurement', () => {
    it('passes for active, non-blacklisted supplier', async () => {
      const { validateSupplierForProcurement } = await import('../modules/supplier/supplier.service.js');

      // Create a clean supplier
      const result = await db.query(
        `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type)
         VALUES ('Test Supplier Validate OK', '{"phone":"555-0001"}', 7, 'external')
         RETURNING id`,
      );
      const id = result.rows[0].id as number;

      await expect(validateSupplierForProcurement(id)).resolves.toBeUndefined();

      await db.query(`DELETE FROM suppliers WHERE id = $1`, [id]);
    });

    it('throws SUPPLIER_INACTIVE for inactive supplier', async () => {
      const { validateSupplierForProcurement } = await import('../modules/supplier/supplier.service.js');

      const result = await db.query(
        `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type, is_active)
         VALUES ('Test Supplier Validate Inactive', '{"phone":"555-0002"}', 7, 'external', false)
         RETURNING id`,
      );
      const id = result.rows[0].id as number;

      await expect(validateSupplierForProcurement(id)).rejects.toMatchObject({ code: 'SUPPLIER_INACTIVE' });

      await db.query(`DELETE FROM suppliers WHERE id = $1`, [id]);
    });

    it('throws SUPPLIER_BLACKLISTED for blacklisted supplier', async () => {
      const { validateSupplierForProcurement } = await import('../modules/supplier/supplier.service.js');

      const result = await db.query(
        `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type, is_blacklisted)
         VALUES ('Test Supplier Validate Blacklisted', '{"phone":"555-0003"}', 7, 'external', true)
         RETURNING id`,
      );
      const id = result.rows[0].id as number;

      await expect(validateSupplierForProcurement(id)).rejects.toMatchObject({ code: 'SUPPLIER_BLACKLISTED' });

      await db.query(`DELETE FROM suppliers WHERE id = $1`, [id]);
    });
  });

  // ── Book-Supplier linking ───────────────────────────────────────────────────

  describe('Book-Supplier linking', () => {
    it('links a supplier to a book and returns it sorted by is_primary', async () => {
      if (!bookId) { console.log('Skipping: no books in DB'); return; }

      // Create two suppliers
      const s1 = await db.query(
        `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type)
         VALUES ('Test Supplier Link A', '{"phone":"555-A"}', 7, 'external') RETURNING id`,
      );
      const s2 = await db.query(
        `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type)
         VALUES ('Test Supplier Link B', '{"phone":"555-B"}', 7, 'external') RETURNING id`,
      );
      const sid1 = s1.rows[0].id as number;
      const sid2 = s2.rows[0].id as number;

      // Link both — s2 as primary
      await request(getTestApp())
        .post(`/api/books/${bookId}/suppliers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ supplierId: sid1, supplierSku: 'SKU-A', isPrimary: false });

      await request(getTestApp())
        .post(`/api/books/${bookId}/suppliers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ supplierId: sid2, supplierSku: 'SKU-B', isPrimary: true });

      // Fetch linked suppliers
      const res = await request(getTestApp())
        .get(`/api/books/${bookId}/suppliers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(200);
      const items = res.body.items as Array<{ supplierId: number; isPrimary: boolean }>;
      const linked = items.filter(i => i.supplierId === sid1 || i.supplierId === sid2);
      expect(linked.length).toBe(2);
      // Primary should be first
      expect(linked[0].isPrimary).toBe(true);
      expect(linked[0].supplierId).toBe(sid2);

      // Cleanup
      await db.query(`DELETE FROM book_suppliers WHERE supplier_id IN ($1, $2)`, [sid1, sid2]);
      await db.query(`DELETE FROM suppliers WHERE id IN ($1, $2)`, [sid1, sid2]);
    });

    it('setting isPrimary=true clears previous primary', async () => {
      if (!bookId) return;

      const s1 = await db.query(
        `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type)
         VALUES ('Test Supplier Primary A', '{"phone":"555-PA"}', 7, 'external') RETURNING id`,
      );
      const s2 = await db.query(
        `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type)
         VALUES ('Test Supplier Primary B', '{"phone":"555-PB"}', 7, 'external') RETURNING id`,
      );
      const sid1 = s1.rows[0].id as number;
      const sid2 = s2.rows[0].id as number;

      // Link s1 as primary
      await request(getTestApp())
        .post(`/api/books/${bookId}/suppliers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ supplierId: sid1, isPrimary: true });

      // Now link s2 as primary — should clear s1
      await request(getTestApp())
        .post(`/api/books/${bookId}/suppliers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ supplierId: sid2, isPrimary: true });

      const check = await db.query(
        `SELECT supplier_id, is_primary FROM book_suppliers WHERE book_id = $1 AND supplier_id IN ($2, $3)`,
        [bookId, sid1, sid2],
      );

      const s1Row = check.rows.find((r: { supplier_id: number }) => r.supplier_id === sid1);
      const s2Row = check.rows.find((r: { supplier_id: number }) => r.supplier_id === sid2);

      expect(s1Row?.is_primary).toBe(false);
      expect(s2Row?.is_primary).toBe(true);

      // Cleanup
      await db.query(`DELETE FROM book_suppliers WHERE supplier_id IN ($1, $2)`, [sid1, sid2]);
      await db.query(`DELETE FROM suppliers WHERE id IN ($1, $2)`, [sid1, sid2]);
    });
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  describe('DELETE /api/suppliers/:id', () => {
    it('deletes a supplier with no POs', async () => {
      const result = await db.query(
        `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type)
         VALUES ('Test Supplier Delete Me', '{"phone":"555-DEL"}', 7, 'external') RETURNING id`,
      );
      const id = result.rows[0].id as number;

      const res = await request(getTestApp())
        .delete(`/api/suppliers/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(200);

      const check = await db.query(`SELECT id FROM suppliers WHERE id = $1`, [id]);
      expect(check.rows.length).toBe(0);
    });
  });

  // ── Stock In reference types ────────────────────────────────────────────────

  describe('Stock In reference_type validation', () => {
    it('accepts stock-in with reference_type=manual (no reference_id)', async () => {
      const bookRes = await db.query(`SELECT id FROM books WHERE is_active = true LIMIT 1`);
      if (!bookRes.rows.length) return;
      const bid = bookRes.rows[0].id as number;

      const locRes = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
      if (!locRes.rows.length) return;
      const lid = locRes.rows[0].id as number;

      // Get current version
      await db.query(
        `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
         VALUES ($1, $2, 0, 5, 0) ON CONFLICT DO NOTHING`,
        [bid, lid],
      );
      const inv = await db.query(`SELECT version FROM inventory WHERE book_id = $1 AND location_id = $2`, [bid, lid]);
      const version = inv.rows[0].version as number;

      const res = await request(getTestApp())
        .post('/api/inventory/stock-in')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ bookId: bid, locationId: lid, quantity: 1, version, referenceType: 'manual' });

      expect(res.status).toBe(200);
    });

    it('rejects stock-in with reference_type=purchase_order and no reference_id (400)', async () => {
      const bookRes = await db.query(`SELECT id FROM books WHERE is_active = true LIMIT 1`);
      if (!bookRes.rows.length) return;
      const bid = bookRes.rows[0].id as number;

      const locRes = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
      if (!locRes.rows.length) return;
      const lid = locRes.rows[0].id as number;

      const inv = await db.query(`SELECT version FROM inventory WHERE book_id = $1 AND location_id = $2`, [bid, lid]);
      if (!inv.rows.length) return;
      const version = inv.rows[0].version as number;

      const res = await request(getTestApp())
        .post('/api/inventory/stock-in')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ bookId: bid, locationId: lid, quantity: 1, version, referenceType: 'purchase_order' });

      expect(res.status).toBe(400);
    });
  });
});
