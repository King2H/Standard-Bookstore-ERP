/** PostgreSQL error codes services translate into business errors. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

/** True when `err` is PostgreSQL refusing a duplicate value for a unique column or index. */
export function isUniqueViolation(err: unknown): boolean {
  return hasCode(err, UNIQUE_VIOLATION);
}

/** True when `err` is PostgreSQL refusing a reference to a row that does not exist (or is still referenced). */
export function isForeignKeyViolation(err: unknown): boolean {
  return hasCode(err, FOREIGN_KEY_VIOLATION);
}
