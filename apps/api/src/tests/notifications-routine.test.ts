// #232 (#225 K4; owner decisions 1a, 2a, 2026-11-04): notifications are for
// what someone must act on or should know at once. Routine events (sales,
// stock movements, order and payment steps, ...) notify only where the shop
// or the branch turned them on, in notification_prefs. Before, every event
// notified: a Manager got 21 in a day, 14 of them one per book stocked in.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { ROUTINE_NOTIFICATION_EVENTS } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';
import { runInTenant } from '../db/tenantContext.js';
import { handleNotification, NOTIFICATION_EVENTS } from '../workers/notificationWorker.js';

const STAFF_PREFIX = 'notif_routine_';
const BRANCH_PREFIX = 'Notif Routine ';

describe('Routine notifications are opt-in (#232)', () => {
  let branchId: number;
  let manager: string;
  const notify = (eventType: string, payload: Record<string, unknown> = {}) =>
    runInTenant(1, () => handleNotification({ branchId, bookTitle: 'Routine Book', quantity: 1, locationName: 'Shelf', ...payload, _eventType: eventType }));
  const made = async (eventType: string) =>
    Number((await db.query(`SELECT COUNT(*) AS n FROM notifications WHERE branch_id = $1 AND event_type = $2`, [branchId, eventType])).rows[0].n);
  const setBranchPrefs = (value: unknown, token = manager) =>
    request(getTestApp()).put(`/api/v1/config/branches/${branchId}/notification_prefs`).set('Authorization', `Bearer ${token}`).send({ value });

  async function cleanUp() {
    await db.query(`DELETE FROM notifications WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%')`);
    await db.query(`DELETE FROM branch_config WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%')`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
  });

  afterAll(cleanUp);

  it('makes no notification for a routine event by default (was: one per book stocked in, one per sale)', async () => {
    await notify('inventory.stock_in');
    await notify('pos.sale_completed', { transactionNumber: 'POS-X', grandTotal: 10 });
    await notify('order.created', { orderNumber: 'ORD-X' });
    expect([await made('inventory.stock_in'), await made('pos.sale_completed'), await made('order.created')]).toEqual([0, 0, 0]);
  });

  it('still notifies what someone must act on', async () => {
    await notify('stock_count.submitted', { countId: 1, countNumber: 'CNT-X' });
    await notify('inventory.out_of_stock', { bookId: 1, locationId: 1 });
    expect([await made('stock_count.submitted'), await made('inventory.out_of_stock')]).toEqual([1, 1]);
  });

  it('notifies a purchase order approved by its creator, not a routine approval', async () => {
    await notify('po.approved', { poNumber: 'PO-X', approvalKind: 'approver' });
    expect(await made('po.approved')).toBe(0);
    await notify('po.approved', { poNumber: 'PO-Y', approvalKind: 'creator', reason: 'Only approver' });
    expect(await made('po.approved')).toBe(1);
  });

  it('notifies a routine event the branch turned on, and only that one (2a)', async () => {
    expect((await setBranchPrefs({ 'inventory.stock_in': true })).status).toBe(200);
    await notify('inventory.stock_in');
    await notify('inventory.stock_out');
    expect([await made('inventory.stock_in'), await made('inventory.stock_out')]).toEqual([1, 0]);
  });

  it('takes only routine event names, each on or off', async () => {
    expect((await setBranchPrefs({ 'stock_count.submitted': false })).status).toBe(400);
    expect((await setBranchPrefs({ 'inventory.stock_in': 'yes' })).status).toBe(400);
    expect((await setBranchPrefs({ 'pos.sale_completed': true, 'inventory.stock_in': false })).status).toBe(200);
  });

  it('classes every routine event as one the worker knows', () => {
    for (const event of Object.keys(ROUTINE_NOTIFICATION_EVENTS)) expect(NOTIFICATION_EVENTS).toContain(event);
  });
});
