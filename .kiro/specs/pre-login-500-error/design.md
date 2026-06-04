# Pre-Login 500 Error Bugfix Design

## Overview

The `POST /api/auth/pre-login` route has two related defects:

1. **Unhandled non-`AppError` exceptions surface as raw 500s.** Raw `pg` errors (e.g. connection failures, unexpected query errors) thrown by `db.query()` or `authService.getBranchesForUser()` are not `AppError` instances, so `errorHandler.ts` falls through to the generic 500 branch and returns an unformatted error body rather than the structured shape the rest of the API uses.

2. **Lockout is never applied from pre-login.** When a wrong password is submitted to pre-login, the route increments `failed_login_attempts` but never computes or writes `locked_until`. This is inconsistent with `authService.login()`, which reads the security policy, computes `locked_until`, writes it to the database, and throws `ACCOUNT_LOCKED` once the threshold is reached.

The fix wraps the raw DB calls in the route with `AppError` subclasses and copies the lockout logic from `authService.login()` into the pre-login handler (or extracts it into a shared helper).

---

## Glossary

- **Bug_Condition (C)**: The set of runtime conditions that trigger a defective response from `POST /api/auth/pre-login`.
- **Property (P)**: The required behavior when a bug condition holds — a structured error response with the standard shape `{ error, message, details, requestId, timestamp }` and an appropriate HTTP status code.
- **Preservation**: All behaviours of `POST /api/auth/pre-login` that are already correct and must not change after the fix.
- **`AppError`**: Base class in `src/lib/errors.ts`. The `errorHandler` middleware only applies structured formatting when the thrown value is an instance of `AppError`.
- **`errorHandler`**: Express error-handling middleware in `src/middleware/errorHandler.ts`. Inspects `instanceof AppError` to decide between a structured 4xx/5xx response and a generic 500.
- **`getBranchesForUser`**: Service function in `auth.service.ts` that queries branches for a staff member. Any unguarded `db.query()` call inside it can throw a raw `pg` error.
- **`getSecurityPolicy`**: Service function in `auth.service.ts` that reads `max_failed_login_attempts` and `account_lockout_minutes` from `system_config`. Already used by `authService.login()` but not called by the pre-login route.
- **`locked_until`**: Timestamp column on the `staff` table; set to `now() + lockoutMinutes` when the failed-attempt threshold is reached. The pre-login route never writes this column.

---

## Bug Details

### Bug Condition

The pre-login route is defective when either of the following is true:

- A `db.query()` call inside the route handler throws a native `pg` error (not an `AppError`).
- `authService.getBranchesForUser()` propagates an unhandled query error.
- A correct password is supplied but `failed_login_attempts` has already reached the lockout threshold **only via pre-login attempts** (where `locked_until` was never set), so the account is never locked — a security gap rather than a 500, but tracked as part of the same defect.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type PreLoginRequest (or runtime context)
  OUTPUT: boolean

  // Bug 1 — raw error escapes to generic 500 handler
  IF (db.query() OR getBranchesForUser() throws error
      AND error IS NOT instanceof AppError)
    RETURN true
  END IF

  // Bug 2 — lockout never applied from pre-login
  IF (X.password IS WRONG
      AND (staff.failed_login_attempts + 1) >= maxFailedAttempts
      AND staff.locked_until IS NULL after the UPDATE)
    RETURN true
  END IF

  RETURN false
END FUNCTION
```

### Examples

- **DB unavailable at credential lookup**: `db.query('SELECT ... FROM staff WHERE username = $1')` throws `ECONNREFUSED`. The error is not an `AppError`, so `errorHandler` returns `500 INTERNAL_SERVER_ERROR` with no `requestId` in a consistent format. **Expected**: a structured `503` or `500` with the standard error shape.

- **`getBranchesForUser` query fails**: After successful password validation, `db.query(...)` inside `getBranchesForUser` throws `57P01 admin shutdown`. The catch block in the route calls `next(err)` with a raw `pg` error, yielding a generic 500. **Expected**: the error handler returns a structured response.

- **Lockout not applied from pre-login**: Staff has `failed_login_attempts = 4`, `maxFailedAttempts = 5`. A wrong password is submitted via pre-login. The route sets `failed_login_attempts = 5` but leaves `locked_until = NULL`. A subsequent login attempt via `/api/auth/login` checks `locked_until` first — finds `NULL` — and proceeds to password comparison, effectively bypassing lockout. **Expected**: pre-login writes `locked_until` and throws `ACCOUNT_LOCKED` exactly as `/api/auth/login` does.

- **Edge case — `maxFailedAttempts = 1`**: First wrong-password attempt via pre-login should immediately lock the account. With the bug, no lock is set.

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- A valid username + password combination MUST continue to return `200 OK` with `{ staffId, branches, isAllBranches, autoSelectBranchId }`.
- An unknown username MUST continue to return a `400` `ValidationError` ("Invalid username or password").
- A wrong password (below the lockout threshold) MUST continue to return a `400` `ValidationError` and increment `failed_login_attempts`.
- An already-locked account (where `locked_until` is in the future) MUST continue to return a `400` `ValidationError` with the remaining minutes.
- A deactivated account MUST continue to return a `400` `ValidationError`.
- A malformed request body MUST continue to return a `400` `ValidationError` from schema validation.
- Rate-limit violations MUST continue to return `429 Too Many Requests`.
- The `is_all_branches` fallback path (try/catch around the `is_all_branches` column query) MUST remain unchanged.

**Scope:**
All inputs that do NOT trigger a raw DB error AND do not involve the lockout threshold are unaffected by this fix. This includes all currently-correct happy-path and 4xx flows listed above.

---

## Hypothesized Root Cause

### Bug 1 — Unhandled non-`AppError` exceptions

1. **No `AppError` wrapper around raw `db.query` calls**: The pre-login route calls `db.query(...)` directly. If `pg` throws (connection error, constraint violation, etc.), the error is not an `AppError` subclass. The `errorHandler` middleware checks `err instanceof AppError`; when that check fails it falls through to the generic 500 branch. Fix: wrap the initial staff lookup and the `getBranchesForUser` call in a try/catch that converts unrecognised errors into a structured response (e.g. a new `ServiceUnavailableError` or by re-throwing wrapped in an `AppError`).

2. **`getBranchesForUser` does not wrap its own DB calls**: The service function has no internal error translation layer — it lets `pg` errors propagate as-is. The route's outer try/catch forwards them via `next(err)`, but they arrive at `errorHandler` as plain `Error` objects, not `AppError` instances.

### Bug 2 — `locked_until` never set by pre-login

3. **Security policy not consulted**: The pre-login route hard-codes no threshold — it unconditionally increments `failed_login_attempts` without calling `getSecurityPolicy()`. Consequently, it never knows when to compute `locked_until`.

4. **`UPDATE` statement is incomplete**: The route's wrong-password UPDATE only touches `failed_login_attempts`:
   ```sql
   UPDATE staff SET failed_login_attempts = $1 WHERE id = $2
   ```
   Compared with `authService.login()`, which also sets `locked_until`:
   ```sql
   UPDATE staff SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3
   ```

---

## Correctness Properties

Property 1: Bug Condition — Structured Error on DB/Service Failure

_For any_ pre-login request where `isBugCondition` holds due to a raw `pg` error escaping the route handler, the fixed route SHALL call `next(err)` with a value that is an instance of `AppError` (or is otherwise handled by `errorHandler` to produce a structured JSON response with `error`, `message`, `requestId`, and `timestamp` fields, and an HTTP status code of `500` or `503`). No unhandled exception SHALL reach Express's default error handler.

**Validates: Requirements 2.1, 2.2**

Property 2: Bug Condition — Lockout Applied on Threshold Breach via Pre-Login

_For any_ pre-login request where `isBugCondition` holds because a wrong password is submitted and `(staff.failed_login_attempts + 1) >= maxFailedAttempts`, the fixed route SHALL write a non-null `locked_until` timestamp to the `staff` row AND respond with a structured `400` (or `401`) error indicating the account is locked — identical in semantics to the response produced by `POST /api/auth/login` for the same condition.

**Validates: Requirements 2.3**

Property 3: Preservation — Correct Inputs Unaffected

_For any_ pre-login request where `isBugCondition` does NOT hold (valid credentials, ordinary invalid credentials below threshold, already-locked account, deactivated account, schema validation failure, rate-limit), the fixed route SHALL produce exactly the same response as the original route — same HTTP status code, same response body shape, same database side-effects.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

---

## Fix Implementation

### Changes Required

#### File: `apps/api/src/middleware/errorHandler.ts` or `apps/api/src/lib/errors.ts`

**Optional — add `ServiceUnavailableError` (503):**

If we want to distinguish "the DB is down" from a generic 500, add a new `AppError` subclass:

```typescript
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super('SERVICE_UNAVAILABLE', message, 503);
  }
}
```

This is optional; wrapping in a plain `AppError` with `statusCode: 503` or letting the generic 500 branch format a structured response also satisfies the property.

---

#### File: `apps/api/src/modules/auth/auth.routes.ts`

**Function**: the `POST /auth/pre-login` route handler

**Specific Changes:**

1. **Import `getSecurityPolicy` (or inline the query)**: Call `authService.getSecurityPolicy()` (make it exported) before the failed-attempt check so the lockout threshold is known. Alternatively, inline the equivalent query in the route.

2. **Wrap DB errors in a structured `AppError`**: Surround the initial `db.query(...)` (staff lookup) and `authService.getBranchesForUser(...)` in a try/catch that rethrows raw `pg` errors as `new AppError('SERVICE_UNAVAILABLE', 'Database error', 503)` (or `ServiceUnavailableError`). The outer try/catch already calls `next(err)`, so `AppError` instances will be formatted correctly by `errorHandler`.

3. **Apply lockout logic on wrong password**: Replace the current incomplete UPDATE:
   ```typescript
   // BEFORE
   const newAttempts = (staff.failed_login_attempts ?? 0) + 1;
   await db.query(
     `UPDATE staff SET failed_login_attempts = $1 WHERE id = $2`,
     [newAttempts, staff.id],
   );
   throw new ValidationError('Invalid username or password');
   ```
   With the full lockout logic matching `authService.login()`:
   ```typescript
   // AFTER
   const policy = await authService.getSecurityPolicy(); // exported helper
   const newAttempts = (staff.failed_login_attempts ?? 0) + 1;
   const shouldLock = newAttempts >= policy.maxFailedAttempts;
   const lockedUntil = shouldLock
     ? new Date(Date.now() + policy.lockoutMinutes * 60 * 1000)
     : null;
   await db.query(
     `UPDATE staff SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3`,
     [newAttempts, lockedUntil, staff.id],
   );
   if (shouldLock) {
     throw new ValidationError(
       `Account locked. Try again in ${policy.lockoutMinutes} minute(s).`,
     );
   }
   throw new ValidationError('Invalid username or password');
   ```

4. **Export `getSecurityPolicy` from `auth.service.ts`**: Change the function from `async function getSecurityPolicy()` to `export async function getSecurityPolicy()` so the route can call it without duplicating the query.

5. **No changes needed to `errorHandler.ts`**: The existing `instanceof AppError` check is correct. The bug is that the route never wraps errors as `AppError` instances before forwarding them.

---

## Testing Strategy

### Validation Approach

Testing follows a two-phase approach:

1. **Exploratory / bug-reproduction phase**: Write tests against the _unfixed_ code to confirm both bugs are observable and to establish the expected counterexamples.
2. **Fix + preservation phase**: Run the same tests against the _fixed_ code. Fix-checking tests must now pass; preservation tests must continue to pass.

---

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples on unfixed code. Confirm the root-cause hypotheses.

**Test Plan**: Mock `db.query` to throw a raw `pg` error on the staff-lookup query, then assert the HTTP response. Also mock a wrong-password scenario at the lockout threshold and assert the database update.

**Test Cases:**

1. **DB unavailable on staff lookup** — mock `db.query` to throw `new Error('connection refused')` on the first call; assert the response is NOT a silent crash and that the response body has `error` and `message` fields. On unfixed code, this will produce a `500` but the body may lack `requestId` / `timestamp` depending on Express defaults, or the promise may reject without a response.

2. **`getBranchesForUser` throws raw error** — let the staff-lookup succeed (return a valid row with correct password), mock `getBranchesForUser` to throw `new Error('query timeout')`; assert the response has the standard error shape. On unfixed code, the outer `next(err)` call forwards a plain `Error`, producing an unformatted `500`.

3. **Lockout threshold reached via pre-login** — seed `failed_login_attempts = maxFailedAttempts - 1`, submit wrong password; inspect the `staff` row after the request. On unfixed code, `locked_until` will remain `NULL`.

4. **Lockout threshold = 1 (edge case)** — configure `maxFailedAttempts = 1`, submit a single wrong-password attempt; assert `locked_until` is set. On unfixed code, `locked_until` remains `NULL`.

**Expected Counterexamples:**
- Response body on DB error lacks `requestId` and `timestamp` (plain `Error` reaches the fallback 500 branch).
- `locked_until` column is `NULL` after the wrong-password threshold is reached.

---

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed route produces the expected behavior.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  result := preLogin_fixed(X)

  IF X triggers DB/service error THEN
    ASSERT result.statusCode IN {500, 503}
    ASSERT result.body.error IS NOT NULL
    ASSERT result.body.message IS NOT NULL
    ASSERT result.body.requestId IS NOT NULL
    ASSERT result.body.timestamp IS NOT NULL
  END IF

  IF X triggers lockout threshold THEN
    ASSERT staff.locked_until IS NOT NULL after request
    ASSERT result.statusCode IN {400, 401}
    ASSERT result.body.error IS NOT NULL
  END IF
END FOR
```

---

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed route produces the same result as the original.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT preLogin_original(X) = preLogin_fixed(X)
END FOR
```

**Testing Approach**: Property-based testing is well-suited here because:
- The space of valid and invalid credential combinations is large.
- Generating random usernames, passwords, and account states catches edge cases in the lockout counter logic that hand-written tests might miss.
- Strong guarantees that the fix doesn't accidentally alter the 200 OK path or the sub-threshold wrong-password path.

**Test Cases:**

1. **Happy path preservation** — valid credentials, reachable DB; assert `200 OK` with `{ staffId, branches, isAllBranches, autoSelectBranchId }`.
2. **Unknown username preservation** — username not in DB; assert `400 ValidationError`.
3. **Wrong password below threshold** — `failed_login_attempts < maxFailedAttempts - 1`; assert `400`, assert `failed_login_attempts` incremented, `locked_until` remains `NULL`.
4. **Already-locked account** — `locked_until` in the future; assert `400` with lock message, no DB writes.
5. **Deactivated account** — `is_active = false`; assert `400`.
6. **Schema validation failure** — missing `username` or `password` field; assert `400`.
7. **Rate limit** — exceeds loginRateLimit; assert `429`.

---

### Unit Tests

- Mock `db.query` to throw a raw `Error` on the staff-lookup and assert the response is a structured error with `requestId`.
- Mock `db.query` to throw after successful credential validation (simulating a failure inside `getBranchesForUser`) and assert structured error response.
- Test wrong-password at exactly `maxFailedAttempts - 1` (should NOT lock) vs. `maxFailedAttempts` (SHOULD lock) and verify `locked_until` is `NULL` vs. a future timestamp respectively.
- Test with `maxFailedAttempts = 1` (lock on first failure).

### Property-Based Tests

- Generate random `(username, password)` pairs where the username exists in a seeded test DB; verify the response always matches the pre-fix contract for non-buggy inputs.
- Generate random `failed_login_attempts` values (0 to `maxFailedAttempts - 1`) with a wrong password; verify `locked_until` remains `NULL` and `failed_login_attempts` is incremented by 1.
- Generate `failed_login_attempts = maxFailedAttempts - 1` with a wrong password; verify `locked_until` is a future timestamp after the fix.

### Integration Tests

- Full request against a test database: DB unavailable → structured 503/500 response with correct shape.
- Full request: wrong password at threshold → `locked_until` set → subsequent correct-password pre-login blocked by lockout check.
- Full request: valid credentials → `200 OK` with expected branch list — confirms the fix does not break the happy path.
- Full request: wrong password below threshold → `failed_login_attempts` incremented, `locked_until` `NULL`, same `400` response as before.
