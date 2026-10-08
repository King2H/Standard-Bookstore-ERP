/** PostgreSQL error codes services translate into business errors. */
const UNIQUE_VIOLATION = '23505';

/** True when `err` is PostgreSQL refusing a duplicate value for a unique column or index. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;
}
