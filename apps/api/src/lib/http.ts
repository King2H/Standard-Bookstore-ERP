import { ValidationError } from './errors.js';

/**
 * Small request-shape helpers.
 *
 * @types/express@5.0.6 types route-param values as `string | string[]` to
 * account for Express 5's wildcard segments (e.g. `/files/*splat`), which can
 * legitimately capture multiple values. None of the routes using paramStr()
 * are wildcards — they're plain named segments (`:id`, `:branchId`, ...) —
 * so Express only ever hands back a single string for them at runtime. This
 * narrows the type at the call site instead of every caller repeating an
 * unchecked cast (or the codebase carrying ~20 TS errors that mask real ones).
 */
export function paramStr(v: string | string[]): string {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Parses a numeric route param (e.g. `:id`, `:branchId`) and throws a clean
 * ValidationError on anything non-numeric, instead of letting a NaN slip
 * through to a SQL query and surface as a raw, unhandled Postgres error
 * ("invalid input syntax for type integer") — which the error handler
 * doesn't recognize as an AppError, so it falls through to a generic 500
 * instead of a 400. Bug Sweep finding: several route files called
 * `parseInt(req.params.id as string, 10)` directly with no such guard.
 */
export function paramInt(v: string | string[]): number {
  const n = parseInt(paramStr(v), 10);
  if (Number.isNaN(n)) {
    throw new ValidationError(`Invalid numeric route parameter: '${paramStr(v)}'`);
  }
  return n;
}
