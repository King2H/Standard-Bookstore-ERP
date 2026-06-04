# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Pre-Login Raw Error Escapes + Lockout Never Written
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms both bugs exist
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface concrete counterexamples demonstrating the two bugs
  - **Scoped PBT Approach**: Both bugs are deterministic; scope to concrete trigger cases for reproducibility
  - Create `apps/api/src/tests/pre-login-bug-condition.test.ts`
  - Use `vi.spyOn(db, 'query')` to simulate raw `pg` errors (not `AppError` instances) on the staff-lookup query, then call `POST /api/auth/pre-login` and assert the response body contains `error`, `message`, `requestId`, and `timestamp` — on unfixed code the response will be a raw 500 lacking `requestId`/`timestamp` in the structured shape
  - Use `vi.spyOn(authService, 'getBranchesForUser')` to throw `new Error('query timeout')` after a correct password; assert the response body has the four required fields — on unfixed code the forwarded plain `Error` hits the generic 500 branch without a structured body
  - Seed a staff row with `failed_login_attempts = maxFailedAttempts - 1` (use `maxFailedAttempts = 5` from default policy), submit a wrong password, then query `SELECT locked_until FROM staff WHERE id = $1`; assert `locked_until IS NOT NULL` — on unfixed code `locked_until` will be `NULL`
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct — proves both bugs exist)
  - Document counterexamples found:
    - "DB error response body lacks `requestId`/`timestamp` (plain Error reaches generic 500 branch)"
    - "`locked_until` is NULL after wrong-password at threshold (UPDATE never sets it)"
  - Mark task complete when test is written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Buggy Pre-Login Flows Unchanged
  - **IMPORTANT**: Follow observation-first methodology — run UNFIXED code to observe actual baseline behavior first
  - Create `apps/api/src/tests/pre-login-preservation.test.ts`
  - Observe on unfixed code:
    - `POST /api/auth/pre-login` with valid credentials → `200 OK` with `{ staffId, branches, isAllBranches, autoSelectBranchId }`
    - Unknown username → `400` with `error: 'VALIDATION_ERROR'`
    - Wrong password at `failed_login_attempts = 0` (below threshold) → `400`, DB row shows `failed_login_attempts = 1`, `locked_until = NULL`
    - Wrong password at `failed_login_attempts = 2` with threshold `= 5` → `400`, `failed_login_attempts = 3`, `locked_until = NULL`
    - Already-locked account (`locked_until` in the future) → `400` with lock message
    - Deactivated account → `400` with deactivated message
    - Missing `username` field in body → `400` schema validation error
  - Write property-based tests using `vitest` (property via `fc` / `fast-check` if installed, or parameterized `it.each` with generated values):
    - For any `failed_login_attempts` value in `[0, maxFailedAttempts - 2]` with a wrong password, assert `locked_until` remains `NULL` and attempt counter increments by 1 (from Preservation Requirements 3.2 in design)
    - For valid credential inputs across different staff/branch combinations, assert response shape is always `{ staffId, branches, isAllBranches, autoSelectBranchId }` (Preservation Requirements 3.1)
  - Verify tests PASS on UNFIXED code before proceeding to implementation
  - **EXPECTED OUTCOME**: All preservation tests PASS on unfixed code (confirms correct baseline to protect)
  - Mark task complete when tests are written, run, and all pass on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 3. Fix the pre-login 500 error and missing lockout

  - [x] 3.1 Add `ServiceUnavailableError` to `apps/api/src/lib/errors.ts` (optional but recommended)
    - Append a new `ServiceUnavailableError` subclass of `AppError` with `statusCode: 503` and `code: 'SERVICE_UNAVAILABLE'`
    - Default message: `'Service temporarily unavailable'`
    - _Bug_Condition: isBugCondition(X) where db.query() or getBranchesForUser() throws a non-AppError exception_
    - _Expected_Behavior: route calls next(err) with an AppError instance so errorHandler formats a structured 503/500 response_
    - _Requirements: 2.1, 2.2_

  - [x] 3.2 Export `getSecurityPolicy` from `apps/api/src/modules/auth/auth.service.ts`
    - Change `async function getSecurityPolicy()` to `export async function getSecurityPolicy()`
    - No other changes to the function body
    - _Bug_Condition: isBugCondition(X) where wrong password at threshold leaves locked_until = NULL because policy was never fetched_
    - _Preservation: getSecurityPolicy is already correct internally — only export keyword changes_
    - _Requirements: 2.3_

  - [x] 3.3 Wrap raw DB calls in `POST /auth/pre-login` with AppError (Bug 1 fix)
    - In `apps/api/src/modules/auth/auth.routes.ts`, inside the pre-login handler, wrap the initial `db.query(...)` staff-lookup in a try/catch that catches non-`AppError` errors and rethrows as `new ServiceUnavailableError()` (or `new AppError('SERVICE_UNAVAILABLE', 'Database error', 503)`)
    - Wrap the `authService.getBranchesForUser(staff.id)` call in a try/catch that does the same — catches raw errors, rethrows as `ServiceUnavailableError`
    - Import `ServiceUnavailableError` (or `AppError`) from `../../lib/errors.js`
    - _Bug_Condition: isBugCondition(X) where db.query() or getBranchesForUser() throws non-AppError_
    - _Expected_Behavior: errorHandler receives AppError instance, returns structured { error, message, requestId, timestamp } with status 503_
    - _Requirements: 2.1, 2.2_

  - [x] 3.4 Apply full lockout logic on wrong password in `POST /auth/pre-login` (Bug 2 fix)
    - Import `getSecurityPolicy` from `./auth.service.js`
    - Before (or at) the wrong-password branch, call `const policy = await authService.getSecurityPolicy()` (this call itself should be inside the DB-error try/catch from 3.3 or its own guard)
    - Replace the current incomplete UPDATE:
      ```typescript
      // BEFORE
      await db.query(
        `UPDATE staff SET failed_login_attempts = $1 WHERE id = $2`,
        [newAttempts, staff.id],
      );
      throw new ValidationError('Invalid username or password');
      ```
      With the full lockout-aware UPDATE matching `authService.login()`:
      ```typescript
      // AFTER
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
    - _Bug_Condition: isBugCondition(X) where (failed_login_attempts + 1) >= maxFailedAttempts and locked_until remains NULL_
    - _Expected_Behavior: staff.locked_until is a future timestamp after threshold breach; response is 400 with ACCOUNT_LOCKED semantics_
    - _Preservation: wrong password below threshold still returns 400, increments counter, leaves locked_until NULL (unchanged)_
    - _Requirements: 2.3, 3.2_

  - [x] 3.5 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Pre-Login Raw Error Escapes + Lockout Never Written
    - **IMPORTANT**: Re-run the SAME test file from task 1 — do NOT write a new test
    - The tests from task 1 encode the expected behavior; when they pass, the fix is confirmed
    - Run `apps/api/src/tests/pre-login-bug-condition.test.ts` against the fixed code
    - **EXPECTED OUTCOME**: All tests in that file PASS (confirms both bugs are fixed)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.6 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-Buggy Pre-Login Flows Unchanged
    - **IMPORTANT**: Re-run the SAME test file from task 2 — do NOT write new tests
    - Run `apps/api/src/tests/pre-login-preservation.test.ts` against the fixed code
    - **EXPECTED OUTCOME**: All tests PASS (confirms no regressions in happy path or below-threshold flows)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 4. Checkpoint — Ensure all tests pass
  - Run the full test suite: `cd apps/api && npm test`
  - Confirm `pre-login-bug-condition.test.ts` passes (both DB-error and lockout bugs fixed)
  - Confirm `pre-login-preservation.test.ts` passes (no regressions)
  - Confirm existing `auth.test.ts` still passes (login/logout/RBAC flows unaffected)
  - If any test fails, investigate before proceeding — do not silence failures
  - Ask the user if questions arise about intent or scope
