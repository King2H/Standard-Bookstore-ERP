import { createDecipheriv } from 'node:crypto';

// The import from a v1 shop (#246 part 5, owner decisions 1a–4a): pure rules
// for reading a copy of a v1 database (release/1.x) into the files of the
// Import / Export page.

/** The last migration v1 has: anything past it is a v2 database. */
const V1_LAST_MIGRATION = 1700000050;

export type DatabaseKind = 'empty' | 'v1' | 'v2' | 'other';

/** What a database is, from its tables and the last migration applied. */
export function databaseKind(db: { tables: string[]; lastMigration: string | null }): DatabaseKind {
  if (db.tables.length === 0) return 'empty';
  if (!db.tables.includes('pgmigrations') || !db.lastMigration) return 'other';
  if (db.tables.includes('tenants')) return 'v2';
  return Number(db.lastMigration.split('_')[0]) <= V1_LAST_MIGRATION ? 'v1' : 'v2';
}

function keyOf(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error('The key must be 64 hexadecimal characters: COLUMN_ENCRYPTION_KEY of the v1 API');
  return Buffer.from(keyHex, 'hex');
}

/**
 * A value v1 encrypted (base64 of a 12-byte IV, the 16-byte GCM tag and the
 * ciphertext), opened with its key; null when the key does not open it.
 */
export function openV1Value(value: string, key: Buffer): string | null {
  try {
    const buf = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** How many encrypted values the key opens. A wrong key opens none. */
export function checkColumnKey(values: string[], keyHex: string): { checked: number; unreadable: number } {
  const key = keyOf(keyHex);
  return { checked: values.length, unreadable: values.filter((v) => openV1Value(v, key) === null).length };
}

/** A contact as v1 shows it: the encrypted value opened, else the plain column (rows from before encryption). */
export function contactOf(encrypted: string | null, plain: string | null, keyHex: string): string {
  if (encrypted) return openV1Value(encrypted, keyOf(keyHex)) ?? '';
  return plain?.trim() ?? '';
}

/**
 * A book's format: the one it was given from the shop's list, else its older
 * free text when that names one of the list (as v1's own migration matched
 * them); undefined with none, null when the text names none of the list
 * (left empty, and said in the summary).
 */
export function formatOf(label: string | null, text: string | null, formats: ReadonlyArray<{ code: string; label: string }>): string | null | undefined {
  if (label) return label;
  const wanted = text?.trim().toLowerCase();
  if (!wanted) return undefined;
  return formats.find((f) => f.code.toLowerCase() === wanted || f.label.toLowerCase() === wanted)?.label ?? null;
}

/** Points are whole numbers in v2; v1 kept two decimals. Rounded down: the shop never gives more than it owed. */
export function wholePoints(points: string): number {
  return Math.floor(Number(points));
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export type CopyKind = 'custom' | 'tar' | 'sql' | 'gzip' | 'unknown';

/**
 * What a copy of a database is, from its first 512 bytes: pg_dump's custom
 * format (what the command makes from an address), its tar format (or a
 * directory dump packed in a tar), plain SQL, or one of them gzipped.
 */
export function copyKind(head: Buffer): CopyKind {
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head.subarray(0, 5).toString('latin1') === 'PGDMP') return 'custom';
  if (head.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  const text = head.toString('utf8').replace(/\0+$/, '');
  if (/^(--|SET |CREATE |\\connect)/m.test(text) && /PostgreSQL|SET |CREATE /.test(text)) return 'sql';
  return 'unknown';
}
