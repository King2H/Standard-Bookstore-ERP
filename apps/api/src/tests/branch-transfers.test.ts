/**
 * branch-transfers.test.ts
 *
 * #170 (owner decisions 1a–6a, 2026-10-26): books move between branches on
 * a transfer note, numbered TRF- by the shop's counter. The sending branch
 * drafts it (edit and cancel while a draft) and dispatches it: the copies
 * leave the source location at its average cost, never below zero, and are
 * in transit, valued apart from either branch's stock. The receiving branch
 * receives them, line by line, into its own locations, at the sender's cost
 * weighed into its average. What did not arrive is resolved by an Admin or
 * Manager with a reason: lost (a loss) or damaged (into damaged stock) by the
 * receiving branch, returned to sender by the sending branch. Admin, Manager
 * and Stock_Clerk send and receive (SEND_TRANSFER, RECEIVE_TRANSFER); each
 * side acts from its own branch. Before, a transfer between branches was
 * refused and the cost and the link between the two were lost.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';
import { handleNotification, NOTIFICATION_EVENTS } from '../workers/notificationWorker.js';
import { HANDLERS } from '../workers/outboxPoller.js';

const STAFF_PREFIX = 'trf_test_';
const BRANCH_PREFIX = 'Transfers ';

describe('Transfers between branches', () => {
  let branchA: number;
  let branchB: number;
  let branchC: number;
  let shelfA: number;
  let backA: number;
  let shelfB: number;
  let bookId: number;
  let book2: number;
  const t: Record<string, string> = {};
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const locations = `SELECT id FROM locations WHERE branch_id IN (${branches})`;
    for (const statement of [
      `DELETE FROM notifications WHERE branch_id IN (${branches})`,
      `DELETE FROM branch_transfer_events WHERE transfer_id IN (SELECT id FROM branch_transfers WHERE from_branch_id IN (${branches}))`,
      `DELETE FROM branch_transfer_lines WHERE transfer_id IN (SELECT id FROM branch_transfers WHERE from_branch_id IN (${branches}))`,
      `DELETE FROM branch_transfers WHERE from_branch_id IN (${branches})`,
      `DELETE FROM staff_locations WHERE location_id IN (${locations})`,
      `DELETE FROM inventory_history WHERE location_id IN (${locations})`,
      `DELETE FROM inventory WHERE location_id IN (${locations})`,
      `DELETE FROM branch_config WHERE branch_id IN (${branches})`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => {
        // Before the migration the transfer tables do not exist yet.
        if (err.code !== '42P01') throw err;
      });
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  const level = async (location: number, book = bookId) =>
    one(`SELECT quantity, average_cost, damaged_quantity, damaged_value FROM inventory WHERE book_id = $1 AND location_id = $2`, [book, location]);
  const draft = (lines: Array<{ bookId: number; quantity: number }>, token = t.clerkA, extra: object = {}) =>
    as(api().post('/api/v1/transfers'), token).send({ fromLocationId: shelfA, toBranchId: branchB, lines, ...extra });
  const act = (id: number, step: string, token: string, body: object = {}) => as(api().post(`/api/v1/transfers/${id}/${step}`), token).send(body);
  /** A transfer of `quantity` copies of the book, dispatched; its id and line id. */
  async function sent(quantity: number) {
    const created = await draft([{ bookId, quantity }]);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const dispatched = await act(created.body.id, 'dispatch', t.clerkA);
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    return { id: created.body.id as number, lineId: created.body.lines[0].id as number, number: created.body.transferNumber as string };
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    branchC = (await createTestBranch({ name: `${BRANCH_PREFIX}C` })).branchId;
    for (const [name, role, branchId] of [
      ['clerkA', 'Stock_Clerk', branchA], ['mgrA', 'Manager', branchA], ['salesA', 'Sales', branchA],
      ['clerkB', 'Stock_Clerk', branchB], ['mgrB', 'Manager', branchB], ['clerkC', 'Stock_Clerk', branchC],
      ['limitedA', 'Stock_Clerk', branchA],
    ] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId })).token;
    }
    const loc = async (branch: number, name: string, isDefault: boolean) =>
      (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, $3) RETURNING id`, [branch, name, isDefault])).id as number;
    shelfA = await loc(branchA, 'Transfers A shelf', true);
    backA = await loc(branchA, 'Transfers A back room', false);
    shelfB = await loc(branchB, 'Transfers B shelf', true);
    await loc(branchC, 'Transfers C shelf', true);
    const limited = await one(`SELECT id FROM staff WHERE username = $1`, [`${STAFF_PREFIX}limitedA`]);
    await db.query(`INSERT INTO staff_locations (staff_id, location_id) VALUES ($1, $2)`, [limited.id, backA]);

    const books = (await db.query(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 2`)).rows;
    [bookId, book2] = books.map((b) => b.id as number);
    // A holds 40 at 6.00; B holds 10 at 10.00.
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 40, 6)`, [bookId, shelfA]);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 3, 5)`, [book2, shelfA]);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 10, 10)`, [bookId, shelfB]);
  });

  afterAll(cleanUp);

  it('moves books to another branch: sent at the source\'s cost, in transit, received into the destination\'s average (was: refused)', async () => {
    const created = await draft([{ bookId, quantity: 5 }], t.clerkA, { notes: 'For the new shop' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      status: 'draft', fromBranchId: branchA, fromLocationId: shelfA, toBranchId: branchB, notes: 'For the new shop', inTransitValue: 0,
      lines: [{ bookId, quantity: 5, unitCost: null, receivedQuantity: 0, outstandingQuantity: 0 }],
    });
    expect(created.body.transferNumber).toMatch(/^TRF-\d{8}-\d{4}$/);
    expect(Number((await level(shelfA)).quantity)).toBe(40);
    const id = created.body.id as number;

    const dispatched = await act(id, 'dispatch', t.clerkA);
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    expect(dispatched.body).toMatchObject({
      status: 'in_transit', inTransitValue: 30, lines: [{ quantity: 5, unitCost: 6, outstandingQuantity: 5 }],
    });
    expect(dispatched.body.dispatchedAt).toEqual(expect.any(String));
    // The copies left at their cost; the average there stays.
    expect(await level(shelfA)).toMatchObject({ quantity: 35, average_cost: '6.0000' });
    expect(await one(
      `SELECT movement_type, reason_code, delta, unit_cost FROM inventory_history WHERE reference_type = 'branch_transfer' AND reference_id = $1`, [id],
    )).toEqual({ movement_type: 'transfer_out', reason_code: 'transfer_out', delta: -5, unit_cost: '6.00' });

    // Valued apart: in neither branch's stock, in the dashboard of both.
    const kpis = async (token: string) => (await as(api().get('/api/v1/reports/kpis'), token)).body;
    expect(await kpis(t.mgrA)).toMatchObject({ inventoryInTransit: 30 });
    expect(await kpis(t.mgrB)).toMatchObject({ inventoryInTransit: 30, inventoryValue: 100 });
    const csv = await as(api().get('/api/v1/reports/inventory-valuation/export'), t.mgrB);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(`In transit ${created.body.transferNumber}`);

    const received = await act(id, 'receive', t.clerkB, { locationId: shelfB, items: [{ lineId: created.body.lines[0].id, quantity: 5 }] });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    expect(received.body).toMatchObject({ status: 'received', inTransitValue: 0, lines: [{ receivedQuantity: 5, outstandingQuantity: 0 }] });
    expect(received.body.completedAt).toEqual(expect.any(String));
    // (10 × 10.00 + 5 × 6.00) / 15
    expect(await level(shelfB)).toMatchObject({ quantity: 15, average_cost: '8.6667' });
    expect(await one(
      `SELECT movement_type, delta, unit_cost FROM inventory_history WHERE reference_type = 'branch_transfer' AND reference_id = $1 AND location_id = $2`, [id, shelfB],
    )).toEqual({ movement_type: 'transfer_in', delta: 5, unit_cost: '6.00' });
    expect((await kpis(t.mgrB)).inventoryInTransit).toBe(0);

    const audit = (await db.query(`SELECT meta->>'action' AS action FROM audit_logs WHERE entity_type = 'branch_transfer' AND entity_id = $1 ORDER BY id`, [String(id)])).rows;
    expect(audit.map((r) => r.action)).toEqual(['create', 'dispatch', 'receive']);
  });

  it('tells the receiving branch it is on its way', async () => {
    const { id, number } = await sent(1);
    const event = await one(`SELECT payload FROM outbox WHERE event_type = 'transfer.dispatched' AND payload->>'transferId' = $1`, [String(id)]);
    expect(event.payload).toMatchObject({ branchId: branchB, transferNumber: number, quantity: 1 });
    await handleNotification({ ...event.payload, _eventType: 'transfer.dispatched' });
    const note = await one(`SELECT body, target_roles, branch_id, entity_type FROM notifications WHERE event_type = 'transfer.dispatched' AND entity_id = $1`, [String(id)]);
    expect(note).toMatchObject({ branch_id: branchB, entity_type: 'branch_transfer', target_roles: ['Stock_Clerk', 'Manager', 'Admin'] });
    expect(note.body).toContain(number);
    expect(NOTIFICATION_EVENTS).toContain('transfer.dispatched');
    expect(HANDLERS['transfer.dispatched']).toBe(handleNotification);
  });

  it('is edited and cancelled only as a draft, by the sending branch', async () => {
    const created = await draft([{ bookId, quantity: 2 }]);
    const id = created.body.id as number;
    const edited = await as(api().put(`/api/v1/transfers/${id}`), t.clerkA).send({
      fromLocationId: shelfA, toBranchId: branchB, lines: [{ bookId, quantity: 1 }, { bookId: book2, quantity: 2 }],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.lines.map((l: { bookId: number; quantity: number }) => [l.bookId, l.quantity])).toEqual([[bookId, 1], [book2, 2]]);
    expect((await as(api().put(`/api/v1/transfers/${id}`), t.clerkB).send({ fromLocationId: shelfA, toBranchId: branchB, lines: [{ bookId, quantity: 1 }] })).status).toBe(403);

    const cancelled = await act(id, 'cancel', t.clerkA);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelledAt: expect.any(String) });
    const again = await act(id, 'dispatch', t.clerkA);
    expect(again.status).toBe(422);
    expect(again.body.error).toBe('TRANSFER_INVALID_STATUS');

    const { id: onTheWay } = await sent(1);
    for (const res of [
      await act(onTheWay, 'cancel', t.clerkA),
      await as(api().put(`/api/v1/transfers/${onTheWay}`), t.clerkA).send({ fromLocationId: shelfA, toBranchId: branchB, lines: [{ bookId, quantity: 1 }] }),
    ]) {
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('TRANSFER_INVALID_STATUS');
    }
  });

  it('never takes the source below zero, even where the branch allows negative stock', async () => {
    const staff = await one(`SELECT id FROM staff WHERE username = $1`, [`${STAFF_PREFIX}mgrA`]);
    await db.query(`INSERT INTO branch_config (branch_id, key, value, updated_by) VALUES ($1, 'allow_negative_stock', 'true', $2)`, [branchA, staff.id]);
    try {
      const created = await draft([{ bookId: book2, quantity: 4 }]);
      expect(created.status).toBe(201);
      const res = await act(created.body.id, 'dispatch', t.clerkA);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INSUFFICIENT_STOCK');
      expect(Number((await level(shelfA, book2)).quantity)).toBe(3);
      expect((await one(`SELECT status FROM branch_transfers WHERE id = $1`, [created.body.id])).status).toBe('draft');
    } finally {
      await db.query(`DELETE FROM branch_config WHERE branch_id = $1`, [branchA]);
    }
  });

  it('refuses what is not a transfer between branches', async () => {
    const cases: Array<[object, number, string]> = [
      [{ toBranchId: branchA }, 400, 'VALIDATION_ERROR'],
      [{ fromLocationId: shelfB }, 403, 'BRANCH_ACCESS_DENIED'],
      [{ lines: [{ bookId, quantity: 1 }, { bookId, quantity: 2 }] }, 400, 'VALIDATION_ERROR'],
      [{ lines: [{ bookId, quantity: 0 }] }, 400, 'VALIDATION_ERROR'],
      [{ toBranchId: 999999 }, 404, 'NOT_FOUND'],
    ];
    for (const [change, status, error] of cases) {
      const res = await as(api().post('/api/v1/transfers'), t.clerkA).send({ fromLocationId: shelfA, toBranchId: branchB, lines: [{ bookId, quantity: 1 }], ...change });
      expect(res.status, `${JSON.stringify(change)}: ${JSON.stringify(res.body)}`).toBe(status);
      expect(res.body.error).toBe(error);
    }
    await db.query(`UPDATE branches SET is_active = false WHERE id = $1`, [branchC]);
    try {
      const res = await draft([{ bookId, quantity: 1 }], t.clerkA, { toBranchId: branchC });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('BRANCH_INACTIVE');
    } finally {
      await db.query(`UPDATE branches SET is_active = true WHERE id = $1`, [branchC]);
    }
  });

  it('follows the roles and each branch\'s side (strict permissions)', async () => {
    expect((await draft([{ bookId, quantity: 1 }], t.salesA)).status).toBe(403);
    // A Stock_Clerk limited to the back room sends only from there (#72).
    expect((await draft([{ bookId, quantity: 1 }], t.limitedA)).status).toBe(403);

    const { id, lineId } = await sent(2);
    // The receiving branch does not dispatch, the sending branch does not receive.
    const created = await draft([{ bookId, quantity: 1 }]);
    expect((await act(created.body.id, 'dispatch', t.clerkB)).status).toBe(403);
    const wrongSide = await act(id, 'receive', t.clerkA, { locationId: shelfA, items: [{ lineId, quantity: 1 }] });
    expect(wrongSide.status).toBe(403);
    expect(wrongSide.body.error).toBe('BRANCH_ACCESS_DENIED');
    // Into the receiving branch's own locations only.
    expect((await act(id, 'receive', t.clerkB, { locationId: shelfA, items: [{ lineId, quantity: 1 }] })).status).toBe(403);
    // A Stock_Clerk receives but does not resolve.
    const resolve = await act(id, 'resolve', t.clerkB, { lineId, outcome: 'lost', quantity: 1, reason: 'Not in the box' });
    expect(resolve.status).toBe(403);
    expect(resolve.body.error).toBe('PERMISSION_DENIED');

    // Seen by both branches, not by a third.
    expect((await as(api().get(`/api/v1/transfers/${id}`), t.clerkB)).status).toBe(200);
    expect((await as(api().get(`/api/v1/transfers/${id}`), t.clerkC)).status).toBe(404);
    const incoming = await as(api().get('/api/v1/transfers?direction=incoming'), t.clerkB);
    expect(incoming.status).toBe(200);
    expect(incoming.body.items.map((x: { id: number }) => x.id)).toContain(id);
    const outgoing = await as(api().get('/api/v1/transfers?direction=outgoing'), t.clerkB);
    expect(outgoing.body.items.map((x: { id: number }) => x.id)).not.toContain(id);
    expect((await as(api().get('/api/v1/transfers'), t.clerkC)).body.items).toEqual([]);
    expect((await as(api().get('/api/v1/transfers'), t.salesA)).status).toBe(403);
  });

  it('resolves what did not arrive: lost, damaged and returned, each with a reason', async () => {
    const { id, lineId } = await sent(6);
    const beforeA = await level(shelfA);
    const beforeB = await level(shelfB);

    const part = await act(id, 'receive', t.clerkB, { locationId: shelfB, items: [{ lineId, quantity: 3 }] });
    expect(part.status, JSON.stringify(part.body)).toBe(200);
    expect(part.body).toMatchObject({ status: 'partially_received', inTransitValue: 18, lines: [{ receivedQuantity: 3, outstandingQuantity: 3 }] });
    const over = await act(id, 'receive', t.clerkB, { locationId: shelfB, items: [{ lineId, quantity: 4 }] });
    expect(over.status).toBe(422);
    expect(over.body.error).toBe('TRANSFER_OVER_OUTSTANDING');

    const noReason = await act(id, 'resolve', t.mgrB, { lineId, outcome: 'lost', quantity: 1 });
    expect(noReason.status).toBe(400);
    // Lost and damaged are the receiving branch's to say; returned, the sender's.
    expect((await act(id, 'resolve', t.mgrA, { lineId, outcome: 'lost', quantity: 1, reason: 'Not in the box' })).status).toBe(403);
    expect((await act(id, 'resolve', t.mgrB, { lineId, outcome: 'returned', quantity: 1, reason: 'Sent back', locationId: shelfB })).status).toBe(403);

    const lost = await act(id, 'resolve', t.mgrB, { lineId, outcome: 'lost', quantity: 1, reason: 'Not in the box' });
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    expect(lost.body).toMatchObject({ status: 'partially_received', inTransitValue: 12, lines: [{ lostQuantity: 1, outstandingQuantity: 2 }] });

    const damaged = await act(id, 'resolve', t.mgrB, { lineId, outcome: 'damaged', quantity: 1, reason: 'Wet cover', locationId: shelfB });
    expect(damaged.status, JSON.stringify(damaged.body)).toBe(200);
    expect(damaged.body.lines[0]).toMatchObject({ damagedQuantity: 1, outstandingQuantity: 1 });
    const afterB = await level(shelfB);
    expect(afterB.damaged_quantity - beforeB.damaged_quantity).toBe(1);
    expect(Number(afterB.damaged_value) - Number(beforeB.damaged_value)).toBe(6);
    expect(afterB.quantity - beforeB.quantity).toBe(3);

    const returned = await act(id, 'resolve', t.mgrA, { lineId, outcome: 'returned', quantity: 1, reason: 'Wrong edition', locationId: shelfA });
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(returned.body).toMatchObject({ status: 'closed', inTransitValue: 0, lines: [{ returnedQuantity: 1, outstandingQuantity: 0 }] });
    expect(returned.body.completedAt).toEqual(expect.any(String));
    expect((await level(shelfA)).quantity - beforeA.quantity).toBe(1);
    expect(returned.body.events.map((e: { kind: string; quantity: number; reason: string | null }) => [e.kind, e.quantity, e.reason])).toEqual([
      ['received', 3, null], ['lost', 1, 'Not in the box'], ['damaged', 1, 'Wet cover'], ['returned', 1, 'Wrong edition'],
    ]);
    const nothingLeft = await act(id, 'resolve', t.mgrB, { lineId, outcome: 'lost', quantity: 1, reason: 'Again' });
    expect(nothingLeft.status).toBe(422);
    expect(nothingLeft.body.error).toBe('TRANSFER_INVALID_STATUS');
  });
});
