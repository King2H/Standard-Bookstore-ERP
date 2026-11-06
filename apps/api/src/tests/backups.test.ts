// #244 (owner decisions 1a–4a, 2026-11-06): backups of an on-premise
// install. A backup is one file holding the database, the install's .env
// (with the key the customer data is encrypted with) and the shop's
// certificate authority, encrypted with a passphrase chosen at install
// (2a). It runs nightly, and at start when the last good one is older than a
// day, as shop PCs are often off at night (1a). The last 14 daily and 8
// weekly ones are kept, and Admin and Super_Admin are warned when the last
// good backup is more than 26 hours old (3a). Before, there were no backups.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { ownerDb } from './helpers/ownerDb.js';
import { decryptFile, encryptFile } from '../lib/backupArchive.js';
import { backupsToDelete, isStale, nextRunAt, shouldRunAtStart } from '../modules/system/backup.policy.js';

const STAFF_PREFIX = 'backups_';
const BRANCH_PREFIX = 'Backups ';

describe('Backups (#244)', () => {
  describe('the backup file (2a)', () => {
    let dir: string;
    beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'bms-backup-')); });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('comes back as it went in with the passphrase, and is unreadable without it', async () => {
      const plain = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(300_000, 7), Buffer.from('end')]);
      writeFileSync(join(dir, 'plain'), plain);
      await encryptFile(join(dir, 'plain'), join(dir, 'sealed'), 'Long passphrase 2026!');
      const sealed = readFileSync(join(dir, 'sealed'));
      expect(sealed.subarray(0, 8).toString()).toBe('BMSBAK1\n');
      expect(sealed.includes(Buffer.from('PGDMP'))).toBe(false);
      await decryptFile(join(dir, 'sealed'), join(dir, 'back'), 'Long passphrase 2026!');
      expect(readFileSync(join(dir, 'back')).equals(plain)).toBe(true);
      await expect(decryptFile(join(dir, 'sealed'), join(dir, 'wrong'), 'Another passphrase 2026!')).rejects.toThrow(/passphrase/);
    });

    it('refuses a file changed after it was made', async () => {
      const sealed = readFileSync(join(dir, 'sealed'));
      sealed[200] ^= 1;
      writeFileSync(join(dir, 'tampered'), sealed);
      await expect(decryptFile(join(dir, 'tampered'), join(dir, 'out'), 'Long passphrase 2026!')).rejects.toThrow(/passphrase/);
    });
  });

  describe('what is kept (3a)', () => {
    it('keeps the 14 newest and the newest of each of the 8 newest weeks, and never touches other files', () => {
      const names: string[] = [];
      for (let d = 0; d < 70; d++) {
        const day = new Date(Date.UTC(2026, 10, 6) - d * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
        names.push(`bookstore-${day}-023000.bmsbak`);
      }
      names.push('notes.txt', 'bookstore-old-copy.bmsbak');
      const deleted = backupsToDelete(names, { daily: 14, weekly: 8 });
      const kept = names.filter((n) => !deleted.includes(n));
      expect(deleted).not.toContain('notes.txt');
      expect(deleted).not.toContain('bookstore-old-copy.bmsbak');
      expect(kept).toContain('bookstore-20261106-023000.bmsbak');
      expect(kept).toContain('bookstore-20261024-023000.bmsbak');
      // The 14 newest days (6 Nov back to 24 Oct) span 3 of the 8 newest weeks: 5 more weeks keep one each.
      expect(kept.filter((n) => n.endsWith('.bmsbak') && n !== 'bookstore-old-copy.bmsbak')).toHaveLength(14 + 5);
      expect(deleted).toContain('bookstore-20260901-023000.bmsbak');
    });
  });

  describe('when it runs (1a)', () => {
    it('is the next 02:30 in the shop\'s time zone', () => {
      // 21:00 in Addis Ababa (UTC+3) is 18:00 UTC; the next 02:30 there is 23:30 UTC.
      expect(nextRunAt(new Date('2026-11-06T18:00:00Z'), '02:30', 'Africa/Addis_Ababa').toISOString()).toBe('2026-11-06T23:30:00.000Z');
      expect(nextRunAt(new Date('2026-11-06T23:31:00Z'), '02:30', 'Africa/Addis_Ababa').toISOString()).toBe('2026-11-07T23:30:00.000Z');
    });

    it('runs at start when the last good backup is older than a day, or there is none', () => {
      const now = new Date('2026-11-06T08:00:00Z');
      expect(shouldRunAtStart(null, now)).toBe(true);
      expect(shouldRunAtStart(new Date('2026-11-05T07:00:00Z'), now)).toBe(true);
      expect(shouldRunAtStart(new Date('2026-11-05T09:00:00Z'), now)).toBe(false);
    });

    it('warns after 26 hours with no good backup', () => {
      const now = new Date('2026-11-06T08:00:00Z');
      expect(isStale(new Date('2026-11-05T07:00:00Z'), now)).toBe(false);
      expect(isStale(new Date('2026-11-05T05:00:00Z'), now)).toBe(true);
      expect(isStale(null, now)).toBe(true);
    });
  });

  describe('the status Admin and Super_Admin see (3a)', () => {
    let branchId: number;
    const t: Record<string, string> = {};
    const status = (token: string) =>
      request(getTestApp()).get('/api/v1/system/backup-status').set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));
    const run = (ok: boolean, hoursAgo: number, error: string | null = null) => ownerDb().query(
      `INSERT INTO backup_runs (started_at, finished_at, ok, file_name, bytes, error)
       VALUES (now() - make_interval(hours => $1), now() - make_interval(hours => $1), $2, $3, $4, $5)`,
      [hoursAgo, ok, ok ? `bookstore-test-${hoursAgo}.bmsbak` : null, ok ? 1234 : null, error],
    );

    beforeAll(async () => {
      await ownerDb().query(`DELETE FROM backup_runs`);
      await cleanTestStaff(STAFF_PREFIX);
      await cleanTestBranches(BRANCH_PREFIX);
      branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
      for (const [name, role] of [['admin', 'Admin'], ['owner', 'Super_Admin'], ['manager', 'Manager'], ['sales', 'Sales']] as const) {
        t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId })).token;
      }
    });

    afterEach(() => { delete process.env.BMS_BACKUPS; });
    afterAll(async () => {
      await ownerDb().query(`DELETE FROM backup_runs`);
      await cleanTestStaff(STAFF_PREFIX);
      await cleanTestBranches(BRANCH_PREFIX);
    });

    it('is off where backups are not set up (development, no bundle)', async () => {
      const res = await status(t.admin);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ enabled: false, lastSuccessAt: null, lastFailureAt: null, lastError: null, lastFile: null, stale: false });
    });

    it('says when there has been no good backup yet, then the last good one and any failure since', async () => {
      process.env.BMS_BACKUPS = 'on';
      expect((await status(t.owner)).body).toMatchObject({ enabled: true, lastSuccessAt: null, stale: true });
      await run(true, 30);
      expect((await status(t.admin)).body).toMatchObject({ enabled: true, stale: true, lastFile: 'bookstore-test-30.bmsbak' });
      await run(false, 2, 'No space left on device');
      await run(true, 3);
      const body = (await status(t.admin)).body;
      expect(body).toMatchObject({ stale: false, lastFile: 'bookstore-test-3.bmsbak', lastError: 'No space left on device' });
      expect(new Date(body.lastFailureAt).getTime()).toBeGreaterThan(new Date(body.lastSuccessAt).getTime());
    });

    it('is not for other roles', async () => {
      for (const token of [t.manager, t.sales]) expect((await status(token)).status).toBe(403);
    });

    it('is written by the backup service only: the API may not record a run', async () => {
      const { db } = await import('../db/index.js');
      await expect(db.query(`INSERT INTO backup_runs (started_at, finished_at, ok) VALUES (now(), now(), true)`)).rejects.toThrow(/permission denied/);
    });
  });
});
