import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { decryptFile, encryptFile } from '../src/lib/backupArchive.js';
import { backupFileName, backupsToDelete, nextRunAt, shouldRunAtStart } from '../src/modules/system/backup.policy.js';

// The backup service of an on-premise install (#244, owner decisions 1a–4a).
//   node backup.js run       one backup now (also before an upgrade)
//   node backup.js schedule  nightly at BMS_BACKUP_TIME in BMS_TIMEZONE, and at
//                            start when the last good backup is older than a day
//   node backup.js unpack <file> <dir>   decrypt and extract a backup (restore)
// A backup holds the database, the install's .env and the shop's certificate
// authority, encrypted with BMS_BACKUP_PASSPHRASE. Each run is recorded in
// backup_runs, which Admin and Super_Admin see.

const BACKUPS = process.env.BMS_BACKUP_DIR_IN_CONTAINER ?? '/backups';
const BUNDLE_ENV = '/bundle/.env';
const CADDY_DATA = '/caddy-data';
const KEEP = { daily: 14, weekly: 8 };

function passphrase(): string {
  const p = process.env.BMS_BACKUP_PASSPHRASE ?? '';
  if (p.length < 12) throw new Error('BMS_BACKUP_PASSPHRASE is missing or shorter than 12 characters: run the installer again');
  return p;
}

function exec(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr.trim() || `exit ${code}`}`))));
  });
}

async function owner(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  return client;
}

async function record(run: { startedAt: Date; ok: boolean; fileName?: string; bytes?: number; error?: string }): Promise<void> {
  const client = await owner();
  try {
    await client.query(
      `INSERT INTO backup_runs (started_at, finished_at, ok, file_name, bytes, error) VALUES ($1, now(), $2, $3, $4, $5)`,
      [run.startedAt, run.ok, run.fileName ?? null, run.bytes ?? null, run.error ?? null],
    );
  } finally {
    await client.end();
  }
}

async function lastSuccess(): Promise<Date | null> {
  const client = await owner();
  try {
    const { rows } = await client.query<{ at: Date | null }>(`SELECT max(finished_at) AS at FROM backup_runs WHERE ok`);
    return rows[0].at ? new Date(rows[0].at) : null;
  } finally {
    await client.end();
  }
}

/** One backup: dump, pack, encrypt, keep what the rule keeps, record. */
export async function runBackup(): Promise<string> {
  const startedAt = new Date();
  const work = await mkdtemp(join(tmpdir(), 'bms-backup-'));
  try {
    const secret = passphrase();
    const db = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
    await exec('pg_dump', ['--format=custom', '--file', join(work, 'db.dump')], {
      ...process.env, PGHOST: db.hostname, PGPORT: db.port || '5432', PGUSER: decodeURIComponent(db.username),
      PGPASSWORD: decodeURIComponent(db.password), PGDATABASE: db.pathname.slice(1),
    });
    await copyFile(BUNDLE_ENV, join(work, 'install.env'));
    await exec('tar', ['-C', CADDY_DATA, '-cf', join(work, 'caddy-data.tar'), '.']);
    const client = await owner();
    let migration: string | null;
    try {
      migration = (await client.query<{ name: string }>(`SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1`)).rows[0]?.name ?? null;
    } finally {
      await client.end();
    }
    await writeFile(join(work, 'manifest.json'), JSON.stringify({ format: 1, createdAt: startedAt.toISOString(), lastMigration: migration }, null, 2));
    await exec('tar', ['-C', work, '-cf', join(work, 'backup.tar'), 'manifest.json', 'db.dump', 'install.env', 'caddy-data.tar']);

    const name = backupFileName(startedAt);
    const partial = join(BACKUPS, `.${name}.partial`);
    await encryptFile(join(work, 'backup.tar'), partial, secret);
    await rename(partial, join(BACKUPS, name));
    const bytes = (await stat(join(BACKUPS, name))).size;

    for (const old of backupsToDelete(await readdir(BACKUPS), KEEP)) await rm(join(BACKUPS, old), { force: true });
    await record({ startedAt, ok: true, fileName: name, bytes });
    console.log(`Backup written: ${name} (${Math.round(bytes / 1024)} KB)`);
    return name;
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    await record({ startedAt, ok: false, error: message }).catch(() => {});
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function schedule(): Promise<never> {
  const at = process.env.BMS_BACKUP_TIME ?? '02:30';
  const zone = process.env.BMS_TIMEZONE ?? 'Africa/Addis_Ababa';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const attempt = async (): Promise<boolean> => {
    try { await runBackup(); return true; } catch (err) { console.error(`Backup failed: ${(err as Error).message}`); return false; }
  };
  console.log(`Backups: daily at ${at} (${zone}) to the backup folder; kept: ${KEEP.daily} daily, ${KEEP.weekly} weekly.`);
  if (shouldRunAtStart(await lastSuccess(), new Date())) await attempt();
  for (;;) {
    const next = nextRunAt(new Date(), at, zone);
    console.log(`Next backup: ${next.toISOString()}`);
    await sleep(next.getTime() - Date.now());
    // A failure (a drive unplugged, a full disk) is tried again after an hour, then at the next time.
    if (!(await attempt())) { await sleep(3_600_000); await attempt(); }
  }
}

async function unpack(file: string | undefined, dir: string | undefined): Promise<void> {
  if (!file || !dir) throw new Error('Usage: node backup.js unpack <backup file> <folder>');
  await decryptFile(file, join(dir, 'backup.tar'), passphrase());
  await exec('tar', ['-C', dir, '-xf', join(dir, 'backup.tar')]);
  await rm(join(dir, 'backup.tar'));
  console.log(`Unpacked into ${dir}: manifest.json, db.dump, install.env, caddy-data.tar`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'run') await runBackup();
  else if (command === 'schedule') await schedule();
  else if (command === 'unpack') await unpack(args[0], args[1]);
  else throw new Error('Usage: node backup.js run | schedule | unpack <file> <folder>');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
