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
