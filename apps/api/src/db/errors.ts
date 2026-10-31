import { ConflictError } from '../lib/errors.js';

/** PostgreSQL error codes services translate into business errors. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
/** Raised by refuse_closed_day (migration 1700000094) for a write in a closed day or month. */
const DAY_CLOSED = 'BD001';
const MONTH_CLOSED = 'BD002';

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

/**
 * The business error for PostgreSQL refusing a write in a closed day or
 * month (#175), or undefined for any other error.
 */
export function closedPeriodError(err: unknown): ConflictError | undefined {
  const day = typeof err === 'object' && err !== null ? (err as { detail?: unknown }).detail : undefined;
  if (hasCode(err, DAY_CLOSED)) {
    return new ConflictError('DAY_CLOSED', `The day ${String(day)} is closed in this branch; record it on an open day, or ask an Admin to reopen it`, { day });
  }
  if (hasCode(err, MONTH_CLOSED)) {
    return new ConflictError('MONTH_CLOSED', `The month of ${String(day)} is closed; ask an Admin to reopen it`, { day });
  }
  return undefined;
}
