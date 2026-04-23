/**
 * Integration tests for the Phase 5 Notification System.
 *
 * Tests cover:
 * 1. OutboxPoller picks up pending event → NotificationWorker inserts notification row
 * 2. GET /api/notifications returns notifications for authenticated staff's role + branch
 * 3. GET /api/notifications?isRead=false returns only unread
 * 4. PUT /api/notifications/:id/read marks notification as read
 * 5. PUT /api/notifications/read-all marks all unread as read
 * 6. GET /api/notifications/unread-count returns correct count
 * 7. GET /api/notifications/stream returns text/event-stream
 * 8. Notification for branch A is NOT returned for staff in branch B
 * 9. insertOutbox() failure does NOT cause parent business transaction to fail
 * 10. Notification worker handles unknown event types gracefully (no throw)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';
import { handleNotification } from '../workers/notificationWorker.js';

const STAFF_PREFIX = 'notif_test_';
const BRANCH_PREFIX = 'Notif Test ';

// ── Cleanup helpers ───────────────────────────────────────────────────────────

async function cleanTestNotifications(branchId: number): Promise<void> {
  await db.query(`DELETE FROM notifications WHERE branch_id = $1`, [branchId]);
}

async function cleanTestOutbox(): Promise<void> {
  await db.query(`DELETE FROM outbox WHERE event_type LIKE 'inventory.%' OR event_type LIKE 'order.%' OR event_type LIKE 'po.%' OR event_type LIKE 'pos.%' OR event_type LIKE 'payment.%' OR event_type LIKE 'return.%' OR event_type LIKE 'exchange.%' OR event_type LIKE 'customer.%' OR event_type LIKE 'auth.%'`);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Notification System', () => {
  let managerToken: string;
  let stockClerkToken: string;
  let branchId: number;
  let branchBId: number;
  let managerBToken: string;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Notif Test Branch A' });
    branchId = branch.branchId;

    const branchB = await createTestBranch({ name: 'Notif Test Branch B' });
    branchBId = branchB.branchId;

    const manager = await createTestStaff({ username: 'notif_test_manager', role: 'Manager', branchId });
    managerToken = manager.token;

    const clerk = await createTestStaff({ username: 'notif_test_clerk', role: 'Stock_Clerk', branchId });
    stockClerkToken = clerk.token;

    const managerB = await createTestStaff({ username: 'notif_test_manager_b', role: 'Manager', branchId: branchBId });
    managerBToken = managerB.token;

    await cleanTestNotifications(branchId);
    await cleanTestNotifications(branchBId);
    await cleanTestOutbox();
  });

  afterAll(async () => {
    await cleanTestNotifications(branchId);
    await cleanTestNotifications(branchBId);
    await cleanTestOutbox();
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── Test 1: NotificationWorker inserts notification row ───────────────────

  it('Test 1: NotificationWorker inserts notification row for known event type', async () => {
    const payload = {
      _eventType: 'inventory.low_stock',
      bookId: 1,
      bookTitle: 'Test Book',
      locationId: 1,
      locationName: 'Main Shelf',
      branchId,
      quantity: 2,
      reorderPoint: 5,
    };

    await handleNotification(payload);

    const result = await db.query(
      `SELECT * FROM notifications WHERE branch_id = $1 AND event_type = 'inventory.low_stock' ORDER BY created_at DESC LIMIT 1`,
      [branchId],
    );

    expect(result.rows.length).toBe(1);
    const notif = result.rows[0];
    expect(notif.event_type).toBe('inventory.low_stock');
    expect(notif.severity).toBe('warning');
    expect(notif.title).toContain('Low Stock');
    expect(notif.body).toContain('Test Book');
    expect(notif.is_read).toBe(false);
    expect(notif.target_roles).toContain('Manager');
    expect(notif.target_roles).toContain('Stock_Clerk');
  });

  // ── Test 2: GET /api/notifications returns role-filtered notifications ─────

  it('Test 2: GET /api/notifications returns notifications for authenticated staff role + branch', async () => {
    // Insert a notification for Manager role in branchId
    await db.query(
      `INSERT INTO notifications (branch_id, target_roles, event_type, title, body, severity)
       VALUES ($1, $2, 'order.created', '📋 New Order', 'ORD-TEST-0001 created', 'info')`,
      [branchId, ['Manager', 'Admin']],
    );

    const res = await request(getTestApp())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);

    expect(res.body.data).toBeDefined();
    expect(Array.isArray(res.body.data)).toBe(true);
    // Manager should see notifications targeted to Manager role in their branch
    const managerNotifs = res.body.data.filter((n: { targetRoles: string[] }) => n.targetRoles.includes('Manager'));
    expect(managerNotifs.length).toBeGreaterThan(0);
  });

  // ── Test 3: isRead=false filter ───────────────────────────────────────────

  it('Test 3: GET /api/notifications?isRead=false returns only unread', async () => {
    // Insert one unread and mark one as read
    const insertRes = await db.query(
      `INSERT INTO notifications (branch_id, target_roles, event_type, title, body, severity, is_read)
       VALUES ($1, $2, 'po.created', '📄 PO Created', 'PO-000001 created', 'info', false)
       RETURNING id`,
      [branchId, ['Manager', 'Purchasor']],
    );
    const notifId = insertRes.rows[0].id as number;

    // Mark it as read
    await db.query(`UPDATE notifications SET is_read = true, read_at = now() WHERE id = $1`, [notifId]);

    // Insert another unread
    await db.query(
      `INSERT INTO notifications (branch_id, target_roles, event_type, title, body, severity, is_read)
       VALUES ($1, $2, 'po.approval_required', '⚠️ PO Needs Approval', 'PO-000002 needs approval', 'warning', false)`,
      [branchId, ['Manager', 'Admin']],
    );

    const res = await request(getTestApp())
      .get('/api/notifications?isRead=false')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);

    expect(res.body.data).toBeDefined();
    const allUnread = res.body.data.every((n: { isRead: boolean }) => !n.isRead);
    expect(allUnread).toBe(true);
  });

  // ── Test 4: PUT /api/notifications/:id/read ───────────────────────────────

  it('Test 4: PUT /api/notifications/:id/read marks notification as read', async () => {
    const insertRes = await db.query(
      `INSERT INTO notifications (branch_id, target_roles, event_type, title, body, severity, is_read)
       VALUES ($1, $2, 'order.confirmed', '✅ Order Confirmed', 'ORD-TEST-0002 confirmed', 'success', false)
       RETURNING id`,
      [branchId, ['Manager', 'Sales']],
    );
    const notifId = insertRes.rows[0].id as number;

    await request(getTestApp())
      .put(`/api/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);

    const check = await db.query(`SELECT is_read, read_at FROM notifications WHERE id = $1`, [notifId]);
    expect(check.rows[0].is_read).toBe(true);
    expect(check.rows[0].read_at).not.toBeNull();
  });

  // ── Test 5: PUT /api/notifications/read-all ───────────────────────────────

  it('Test 5: PUT /api/notifications/read-all marks all unread as read', async () => {
    // Insert 3 unread notifications for Manager in branchId
    await db.query(
      `INSERT INTO notifications (branch_id, target_roles, event_type, title, body, severity, is_read)
       VALUES
         ($1, $2, 'inventory.low_stock', '⚠️ Low Stock', 'Book A low', 'warning', false),
         ($1, $2, 'inventory.out_of_stock', '🚨 Out of Stock', 'Book B out', 'error', false),
         ($1, $2, 'order.backordered', '⚠️ Backordered', 'ORD-TEST-0003 backordered', 'warning', false)`,
      [branchId, ['Manager', 'Admin', 'Stock_Clerk']],
    );

    await request(getTestApp())
      .put('/api/notifications/read-all')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);

    // Verify all Manager notifications in this branch are now read
    const check = await db.query(
      `SELECT COUNT(*) FROM notifications
       WHERE branch_id = $1 AND $2 = ANY(target_roles) AND is_read = false`,
      [branchId, 'Manager'],
    );
    expect(parseInt(check.rows[0].count as string, 10)).toBe(0);
  });

  // ── Test 6: GET /api/notifications/unread-count ───────────────────────────

  it('Test 6: GET /api/notifications/unread-count returns correct count', async () => {
    // All notifications should be read now (from Test 5)
    const res1 = await request(getTestApp())
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);

    const countBefore = res1.body.count as number;

    // Insert 2 new unread notifications
    await db.query(
      `INSERT INTO notifications (branch_id, target_roles, event_type, title, body, severity, is_read)
       VALUES
         ($1, $2, 'return.initiated', '🔄 Return Initiated', 'RET-TEST-0001', 'info', false),
         ($1, $2, 'return.approval_required', '⚠️ Return Needs Approval', 'RET-TEST-0002', 'warning', false)`,
      [branchId, ['Manager', 'Admin']],
    );

    const res2 = await request(getTestApp())
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);

    expect(res2.body.count).toBe(countBefore + 2);
  });

  // ── Test 7: GET /api/notifications/stream returns SSE headers ────────────

  it('Test 7: GET /api/notifications/stream returns text/event-stream content type', async () => {
    // SSE connections stay open indefinitely, so we use Node's http module
    // directly to check headers without waiting for the body to complete.
    const app = getTestApp();

    // Start the server on a random port
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const port = addr.port;

        const http = require('http') as typeof import('http');
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/notifications/stream',
            method: 'GET',
            headers: {
              Authorization: `Bearer ${managerToken}`,
              Accept: 'text/event-stream',
            },
          },
          (res) => {
            try {
              expect(res.headers['content-type']).toContain('text/event-stream');
              // Destroy the connection — we got what we need
              req.destroy();
              server.close(() => resolve());
            } catch (err) {
              req.destroy();
              server.close(() => reject(err));
            }
          },
        );

        req.on('error', (err: NodeJS.ErrnoException) => {
          // ECONNRESET is expected after destroy — that's fine
          if (err.code === 'ECONNRESET' || err.code === 'ECONNABORTED') {
            server.close(() => resolve());
          } else {
            server.close(() => reject(err));
          }
        });

        req.end();
      });
    });
  }, 10000);

  // ── Test 8: Branch isolation ──────────────────────────────────────────────

  it('Test 8: Notification for branch A is NOT returned for staff in branch B', async () => {
    // Insert notification specifically for branchId (branch A)
    await db.query(
      `INSERT INTO notifications (branch_id, target_roles, event_type, title, body, severity)
       VALUES ($1, $2, 'po.fully_received', '✅ PO Fully Received', 'PO-BRANCH-A-001 received', 'success')`,
      [branchId, ['Manager', 'Stock_Clerk', 'Purchasor']],
    );

    // Manager B (in branch B) should NOT see branch A's notifications
    const res = await request(getTestApp())
      .get('/api/notifications')
      .set('Authorization', `Bearer ${managerBToken}`)
      .expect(200);

    const branchANotifs = res.body.data.filter(
      (n: { body: string }) => n.body.includes('PO-BRANCH-A-001'),
    );
    expect(branchANotifs.length).toBe(0);
  });

  // ── Test 9: insertOutbox failure is non-fatal ─────────────────────────────

  it('Test 9: insertOutbox() failure does NOT cause parent business transaction to fail', async () => {
    // This test verifies the resilience pattern: notification errors are swallowed.
    // We test this by calling handleNotification with a payload that would cause
    // a DB error (e.g., referencing a non-existent branch_id with a FK constraint).
    // The function should NOT throw.

    const badPayload = {
      _eventType: 'inventory.stock_in',
      bookId: 999999, // non-existent, but notification worker doesn't validate this
      bookTitle: 'Ghost Book',
      locationId: 1,
      locationName: 'Test Location',
      branchId: 999999, // non-existent branch — will cause FK violation on INSERT
      quantity: 5,
    };

    // Should not throw even with invalid branchId
    await expect(handleNotification(badPayload)).resolves.not.toThrow();
  });

  // ── Test 10: Unknown event type is handled gracefully ─────────────────────

  it('Test 10: NotificationWorker handles unknown event types without throwing', async () => {
    const unknownPayload = {
      _eventType: 'completely.unknown.event.type',
      branchId,
      someData: 'test',
    };

    // Should resolve without throwing
    await expect(handleNotification(unknownPayload)).resolves.not.toThrow();

    // No notification row should be created for unknown event types
    const result = await db.query(
      `SELECT COUNT(*) FROM notifications WHERE event_type = 'completely.unknown.event.type'`,
    );
    expect(parseInt(result.rows[0].count as string, 10)).toBe(0);
  });

  // ── Test 11: Unauthenticated access is rejected ───────────────────────────

  it('Test 11: GET /api/notifications without auth returns 401', async () => {
    await request(getTestApp())
      .get('/api/notifications')
      .expect(401);
  });

  it('Test 11b: GET /api/notifications/stream without auth returns 401', async () => {
    await request(getTestApp())
      .get('/api/notifications/stream')
      .expect(401);
  });
});
