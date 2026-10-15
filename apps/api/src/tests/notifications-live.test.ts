import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { ownerDb } from './helpers/ownerDb.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';
import { DEFAULT_ADMIN_PASSWORD_HASH } from '../db/seed.js';
import { runInTenant } from '../db/tenantContext.js';
import { handleNotification } from '../workers/notificationWorker.js';

// #23 (Notifications), owner decision 1a: live notifications reach exactly
// the staff the notification list shows them to.
// - The stream kept its connections by staff, branch and role only: a
//   notification with no branch (failed sign-ins, deactivations, password
//   resets, naming the account) went to staff of every tenant.
// - It matched the first role held and the session branch only, so staff
//   later given a role, or with access to all branches, missed them.

const PREFIX = 'notif_live_test_';
const TENANT_NAME = 'Notifications Live Test B';
const PASSWORD = 'Admin@1234'; // DEFAULT_ADMIN_PASSWORD_HASH

describe('Live notifications', () => {
  let server: Server;
  let base: string;
  let tenantB: number;
  let branchA: number;
  let branchOther: number;
  let adminA: string;
  let adminB: string;
  let promoted: string;
  let allBranches: string;
  const open: Array<() => void> = [];

  /** Opens the stream as `token`; collects the titles of the notifications it receives. */
  async function listen(token: string) {
    const ctrl = new AbortController();
    open.push(() => ctrl.abort());
    const res = await fetch(`${base}/api/v1/notifications/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          text += decoder.decode(value, { stream: true });
        }
      } catch { /* closed */ }
    })();
    for (let i = 0; i < 50 && !text.includes('event: connected'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(text).toContain('event: connected');
    return () => [...text.matchAll(/event: notification\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]).body as string);
  }

  const settle = () => new Promise((r) => setTimeout(r, 300));

  async function cleanUp() {
    const owner = ownerDb();
    await owner.query(`DELETE FROM notifications WHERE body LIKE $1`, [`%${PREFIX}%`]);
    const tenant = `SELECT id FROM tenants WHERE name = '${TENANT_NAME}'`;
    await owner.query(`DELETE FROM refresh_tokens WHERE session_id IN (SELECT id FROM staff_sessions WHERE tenant_id IN (${tenant}))`);
    for (const table of ['audit_logs', 'outbox', 'staff_branch_roles', 'staff_sessions', 'staff', 'locations', 'branches']) {
      await owner.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenant})`);
    }
    await owner.query(`DELETE FROM tenants WHERE name = '${TENANT_NAME}'`);
    await cleanTestStaff(PREFIX);
    await cleanTestBranches('Notif Live Test ');
  }

  beforeAll(async () => {
    await cleanUp();
    server = getTestApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    branchA = (await createTestBranch({ name: 'Notif Live Test A' })).branchId;
    branchOther = (await createTestBranch({ name: 'Notif Live Test Other' })).branchId;
    adminA = (await createTestStaff({ username: `${PREFIX}admin_a`, role: 'Admin', branchId: branchA })).token;

    // A Sales clerk first, made Manager of the same branch later.
    const p = await createTestStaff({ username: `${PREFIX}promoted`, role: 'Sales', branchId: branchA });
    await db.query(`INSERT INTO staff_branch_roles (staff_id, branch_id, role) VALUES ($1, $2, 'Manager')`, [p.staffId, branchA]);
    promoted = p.token;

    // A Manager with access to all branches, signed in to another branch.
    const all = await createTestStaff({ username: `${PREFIX}all`, role: 'Manager', branchId: branchOther });
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [all.staffId]);
    allBranches = all.token;

    // A second tenant with its own Admin.
    const owner = ownerDb();
    tenantB = (await owner.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [TENANT_NAME])).rows[0].id;
    const branchB = (await owner.query(
      `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, 'Main Branch', '-', '{}', '{}') RETURNING id`,
      [tenantB],
    )).rows[0].id;
    const staffB = (await owner.query(
      `INSERT INTO staff (tenant_id, username, password_hash, full_name, is_active, must_change_password)
       VALUES ($1, $2, $3, 'Tenant B Admin', true, false) RETURNING id`,
      [tenantB, `${PREFIX}admin_b`, DEFAULT_ADMIN_PASSWORD_HASH],
    )).rows[0].id;
    await owner.query(`INSERT INTO staff_branch_roles (tenant_id, staff_id, branch_id, role) VALUES ($1, $2, $3, 'Admin')`, [tenantB, staffB, branchB]);
    const res = await request(getTestApp()).post('/api/v1/auth/login').send({ username: `${PREFIX}admin_b`, password: PASSWORD, branchId: branchB });
    expect(res.status).toBe(200);
    adminB = res.body.accessToken;
  });

  afterAll(async () => {
    for (const close of open) close();
    await new Promise((r) => server.close(r));
    await cleanUp();
  });

  it('keeps a tenant\'s notifications in that tenant (was: an account named in tenant B was pushed to tenant A\'s admins)', async () => {
    const seenByA = await listen(adminA);
    const seenByB = await listen(adminB);

    await runInTenant(tenantB, () => handleNotification({ _eventType: 'auth.password_reset', username: `${PREFIX}someone_b`, branchId: null }));
    await settle();

    expect(seenByB()).toEqual([expect.stringContaining(`${PREFIX}someone_b`)]);
    expect(seenByA()).toEqual([]);
  });

  it('counts every role held: a Sales clerk also made Manager gets Manager notifications live and in the list (was: neither)', async () => {
    const seen = await listen(promoted);
    await handleNotification({
      _eventType: 'inventory.adjustment', branchId: branchA, bookTitle: `${PREFIX}book`, locationName: 'Floor', delta: -1, bookId: 1,
    });
    await settle();

    expect(seen()).toEqual([expect.stringContaining(`${PREFIX}book`)]);
    const list = await request(getTestApp()).get('/api/v1/notifications?pageSize=100').set('Authorization', `Bearer ${promoted}`);
    expect(list.body.data.map((n: { body: string }) => n.body)).toContainEqual(expect.stringContaining(`${PREFIX}book`));
  });

  it('gives staff with access to all branches every branch\'s notifications live, as the list does (was: the session branch only)', async () => {
    const seen = await listen(allBranches);
    await handleNotification({
      _eventType: 'inventory.adjustment', branchId: branchA, bookTitle: `${PREFIX}elsewhere`, locationName: 'Floor', delta: 2, bookId: 1,
    });
    await settle();

    expect(seen()).toEqual([expect.stringContaining(`${PREFIX}elsewhere`)]);
  });
});
