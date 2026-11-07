import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import pg from 'pg';
import { copyKind } from '../src/modules/imports/v1Export.policy.js';
import { exportV1Shop } from '../src/modules/imports/v1Export.service.js';

// The import from a v1 shop (#246 part 5, owner decisions 1a–4a). Run by
// deploy/import-v1.sh or import-v1.ps1 in a throwaway container of the
// backup image, which has PostgreSQL's own tools and a temporary database:
//   BMS_V1_SOURCE=<v1 database address, or a copy of it> node import-v1.js <folder>
// (the address holds a password: it is never on a command line). With an
// address it first makes a copy (pg_dump), kept in the folder.
// The copy is loaded into the temporary database, checked (v1, and the key
// opens every customer contact), and read into the five files of the
// Import / Export page, written to the folder with summary.txt.
// BMS_V1_KEY is COLUMN_ENCRYPTION_KEY of the v1 API; TEMP_DATABASE_URL the
// temporary database (empty).

/** Runs a tool; its output and errors, or why it failed. */
function exec(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${command} failed: ${err.trim().slice(-1500) || `exit ${code}`}`))));
  });
}

async function headOf(file: string): Promise<Buffer> {
  const handle = await open(file);
  try {
    const head = Buffer.alloc(512);
    await handle.read(head, 0, 512, 0);
    return head;
  } finally {
    await handle.close();
  }
}

/** A directory dump inside a tar: the folder that holds its toc.dat. */
async function tocFolder(root: string): Promise<string | null> {
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === 'toc.dat') return entry.parentPath;
  }
  return null;
}

/** Loads the copy into the temporary database, whichever form it has. */
async function load(file: string, database: string, work: string): Promise<void> {
  let source = file;
  let kind = copyKind(await headOf(source));
  if (kind === 'gzip') {
    source = join(work, 'copy');
    await pipeline(createReadStream(file), createGunzip(), createWriteStream(source));
    kind = copyKind(await headOf(source));
  }
  const restore = (path: string) => exec('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', database, path]);
  if (kind === 'custom') return void await restore(source);
  if (kind === 'tar') {
    const listing = (await exec('tar', ['-tf', source])).out;
    if (listing.split('\n').some((l) => l.trim() === 'toc.dat')) return void await restore(source);
    const folder = join(work, 'unpacked');
    await mkdir(folder);
    await exec('tar', ['-xf', source, '-C', folder]);
    const toc = await tocFolder(folder);
    if (!toc) throw new Error('This tar file holds no database copy (no toc.dat).');
    return void await restore(toc);
  }
  if (kind === 'sql') {
    // A plain dump names the roles and extensions of the v1 server, which the
    // temporary one lacks: those statements fail harmlessly; any other error stops.
    const { err } = await exec('psql', ['--quiet', '--no-psqlrc', '--dbname', database, '--file', source]);
    const errors = err.split('\n').filter((l) => /ERROR:/.test(l) && !/role ".*" does not exist|extension ".*" (already exists|is not available)|must be owner of/.test(l));
    if (errors.length > 0) throw new Error(`The SQL copy did not load: ${errors.slice(0, 5).join('\n')}`);
    return;
  }
  throw new Error('This file is not a copy of a database: give a pg_dump file (custom, tar or SQL, or gzipped) or the v1 database address.');
}

async function main(): Promise<void> {
  const [folder] = process.argv.slice(2);
  const source = process.env.BMS_V1_SOURCE ?? '';
  if (!source || !folder) throw new Error('Usage: BMS_V1_SOURCE=<v1 database address, or a copy of it> node import-v1.js <folder>');
  const key = process.env.BMS_V1_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('The v1 key must be 64 hexadecimal characters: COLUMN_ENCRYPTION_KEY of the v1 API.');
  const database = process.env.TEMP_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/v1';
  await mkdir(folder, { recursive: true });
  await chmod(folder, 0o700);

  let copy = source;
  if (/^postgres(ql)?:\/\//.test(source)) {
    copy = join(folder, 'v1-copy.dump');
    console.log('Copying the v1 database ...');
    // The password goes to pg_dump in its environment, not on its command line.
    const address = new URL(source);
    const password = decodeURIComponent(address.password);
    address.password = '';
    await exec('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', copy, '--dbname', address.toString()], { ...process.env, PGPASSWORD: password });
    await chmod(copy, 0o600);
    console.log(`Copied it to ${copy.split('/').pop()} (${Math.round((await stat(copy)).size / 1024)} KB): keep it as the v1 shop's last backup.`);
  }

  const client = new pg.Client({ connectionString: database });
  await client.connect();
  const work = await mkdtemp(join(tmpdir(), 'v1-'));
  try {
    const tables = await client.query(`SELECT 1 FROM pg_tables WHERE schemaname = 'public' LIMIT 1`);
    if (tables.rows.length > 0) throw new Error('The temporary database is not empty.');
    console.log('Loading the copy ...');
    await load(copy, database, work);
    const result = await exportV1Shop(client, key);
    for (const file of result.files) await writeFile(join(folder, file.name), file.csv, { mode: 0o600 });
    await writeFile(join(folder, 'summary.txt'), `${result.summary.join('\n')}\n`, { mode: 0o600 });
    console.log(`\n${result.summary.join('\n')}`);
  } finally {
    await client.end();
    await rm(work, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  console.error(`\nError: ${(err as Error).message}`);
  process.exit(1);
}
