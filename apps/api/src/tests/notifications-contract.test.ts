import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { NotificationListResponseSchema, UnreadCountResponseSchema } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Behaviour the Notifications migration (#21) adds on top of
// notifications.test.ts: responses follow the shared contracts, and Admins
// see their session branch's notifications like everyone else (#12); they
// saw, counted and marked read every branch's, while the live stream already
// showed only their branch's.

const STAFF_PREFIX = 'notc_test_';
const BRANCH_PREFIX = 'Notif Contract ';
const EVENT = 'notif_contract.test';

describe('Notifications on the shared contracts', () => {
  let branchA: number;
  let branchB: number;
  let adminOfA: string;
  let headOffice: string;
  let inB: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);
  const titles = (res: request.Response) =>
    res.body.data.filter((n: { eventType: string }) => n.eventType === EVENT).map((n: { title: string }) => n.title).sort();
  const isRead = async (id: string) => (await db.query(`SELECT is_read FROM notifications WHERE id = $1`, [id])).rows[0].is_read;

  async function cleanUp() {
    await db.query(`DELETE FROM notifications WHERE event_type = $1`, [EVENT]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    adminOfA = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId: branchA })).token;
    const ho = await createTestStaff({ username: `${STAFF_PREFIX}ho`, role: 'Admin', branchId: branchA });
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [ho.staffId]);
    headOffice = ho.token;
    const insert = `INSERT INTO notifications (branch_id, target_roles, event_type, title, body) VALUES ($1, '{Admin}', '${EVENT}', $2, 'x') RETURNING id`;
    await db.query(insert, [branchA, 'in A']);
    inB = (await db.query(insert, [branchB, 'in B'])).rows[0].id;
    await db.query(insert, [null, 'system-wide']);
  });

  afterAll(cleanUp);

  it('answers in the shape of the shared schemas', async () => {
    const list = await as(api().get('/api/v1/notifications?pageSize=50'), headOffice);
    expect(NotificationListResponseSchema.strict().parse(list.body)).toEqual(list.body);
    const count = await as(api().get('/api/v1/notifications/unread-count'), headOffice);
    expect(UnreadCountResponseSchema.strict().parse(count.body)).toEqual(count.body);
  });

  it('shows an Admin of one branch that branch\'s and the system-wide notifications only (was: every branch)', async () => {
    const res = await as(api().get('/api/v1/notifications?pageSize=100'), adminOfA);
    expect(titles(res)).toEqual(['in A', 'system-wide']);
  });

  it('shows staff with access to all branches every branch', async () => {
    const res = await as(api().get('/api/v1/notifications?pageSize=100'), headOffice);
    expect(titles(res)).toEqual(['in A', 'in B', 'system-wide']);
  });

  it('does not let an Admin of one branch mark another branch\'s notification read (was: marked)', async () => {
    await as(api().put(`/api/v1/notifications/${inB}/read`), adminOfA);
    await as(api().put('/api/v1/notifications/read-all'), adminOfA);
    expect(await isRead(inB)).toBe(false);
  });

  it('answers 400 VALIDATION_ERROR for an id that is not a number', async () => {
    const res = await as(api().put('/api/v1/notifications/abc/read'), adminOfA);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
