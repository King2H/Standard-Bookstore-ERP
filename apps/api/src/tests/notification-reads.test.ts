import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #85: read state was stored on the notification, so when one recipient of a
// role notification read it, it was read for every recipient.

const STAFF_PREFIX = 'nread_test_';
const BRANCH_PREFIX = 'Notif Reads ';
const EVENT = 'notif_reads.test';

describe('Notification read state is per person', () => {
  let first: string;
  let second: string;
  let shared: string;
  let other: string;
  let legacy: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);
  const unread = async (token: string) =>
    (await as(api().get('/api/v1/notifications?isRead=false&pageSize=100'), token)).body.data
      .filter((n: { eventType: string }) => n.eventType === EVENT)
      .map((n: { id: string }) => n.id)
      .sort();

  async function cleanUp() {
    await db.query(`DELETE FROM notifications WHERE event_type = $1`, [EVENT]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    const branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
    first = (await createTestStaff({ username: `${STAFF_PREFIX}one`, role: 'Manager', branchId })).token;
    second = (await createTestStaff({ username: `${STAFF_PREFIX}two`, role: 'Manager', branchId })).token;
    const insert = `INSERT INTO notifications (branch_id, target_roles, event_type, title, body, is_read)
                    VALUES ($1, '{Manager}', '${EVENT}', $2, 'x', $3) RETURNING id`;
    shared = String((await db.query(insert, [branchId, 'shared', false])).rows[0].id);
    other = String((await db.query(insert, [branchId, 'other', false])).rows[0].id);
    legacy = String((await db.query(insert, [branchId, 'read before #85', true])).rows[0].id);
  });

  afterAll(cleanUp);

  it('keeps a notification unread for the other recipients when one reads it (was: read for all)', async () => {
    await as(api().put(`/api/v1/notifications/${shared}/read`), first);

    expect(await unread(first)).toEqual([other]);
    expect(await unread(second)).toEqual([shared, other].sort());
  });

  it('marks all read for the caller only (was: for every recipient)', async () => {
    const res = await as(api().put('/api/v1/notifications/read-all'), first);

    expect(res.body.updated).toBe(1);
    expect(await unread(first)).toEqual([]);
    expect(await unread(second)).toEqual([shared, other].sort());
  });

  it('keeps notifications read before per-person tracking read for everyone', async () => {
    for (const token of [first, second]) expect(await unread(token)).not.toContain(legacy);
  });
});
