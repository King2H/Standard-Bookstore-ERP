# Bugfix Requirements Document

## Introduction

The `POST /api/auth/pre-login` endpoint returns a `500 Internal Server Error` under certain conditions instead of a well-formed error response. This endpoint is the first step of the two-step login flow: it validates credentials and returns the list of branches the user can access. A 500 here blocks the entire login flow.

Code investigation reveals that any unhandled exception inside the route handler — most notably raw database errors (e.g. connection failure, unexpected query error) thrown by `db.query(...)` or `authService.getBranchesForUser(...)` — bypasses the application's typed error hierarchy (`AppError` subclasses) and falls through to the generic error handler, which responds with `500 INTERNAL_SERVER_ERROR`. The route currently has no guard converting these cases into structured 4xx responses.

Additionally, the pre-login route's failed-attempt increment logic is incomplete: it updates `failed_login_attempts` but never sets `locked_until`, so the lockout applied during `POST /api/auth/login` is never enforced consistently from `pre-login`.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the database is unavailable or returns an unexpected error during a pre-login request THEN the system throws an unhandled native `pg` error that is not an `AppError`, causing the error handler to respond with `500 Internal Server Error`

1.2 WHEN `authService.getBranchesForUser()` throws an unhandled error (e.g. query failure) during a pre-login request THEN the system propagates the raw error and responds with `500 Internal Server Error` instead of a structured error response

1.3 WHEN a staff account reaches the maximum failed login attempts via `POST /api/auth/pre-login` THEN the system increments `failed_login_attempts` but does NOT set `locked_until`, so the account is never locked out at this stage — inconsistent with the behavior of `POST /api/auth/login`

### Expected Behavior (Correct)

2.1 WHEN the database is unavailable or returns an unexpected error during a pre-login request THEN the system SHALL respond with a structured `503 Service Unavailable` or `500` response using the standard error shape `{ error, message, requestId, timestamp }` rather than an unhandled exception

2.2 WHEN `authService.getBranchesForUser()` throws an unhandled error during a pre-login request THEN the system SHALL propagate the error through `next(err)` so the error handler returns a consistent structured error response (not a crash or unformatted 500)

2.3 WHEN a staff account reaches the maximum failed login attempts via `POST /api/auth/pre-login` THEN the system SHALL set `locked_until` in addition to incrementing `failed_login_attempts`, consistent with the lockout logic in `POST /api/auth/login`

### Unchanged Behavior (Regression Prevention)

3.1 WHEN valid credentials and a reachable database are provided to `POST /api/auth/pre-login` THEN the system SHALL CONTINUE TO return `200 OK` with `{ staffId, branches, isAllBranches, autoSelectBranchId }`

3.2 WHEN invalid credentials (wrong password) are provided to `POST /api/auth/pre-login` THEN the system SHALL CONTINUE TO return a `400` validation error with the message "Invalid username or password"

3.3 WHEN an unknown username is provided to `POST /api/auth/pre-login` THEN the system SHALL CONTINUE TO return a `400` validation error

3.4 WHEN an account is already locked and a pre-login request is made THEN the system SHALL CONTINUE TO return a `400` validation error indicating the lockout duration

3.5 WHEN a deactivated account attempts pre-login THEN the system SHALL CONTINUE TO return a `400` validation error indicating the account is deactivated

3.6 WHEN the request body fails schema validation (missing `username` or `password`) THEN the system SHALL CONTINUE TO return a `400` validation error

3.7 WHEN the rate limit is exceeded for a given IP/username combination THEN the system SHALL CONTINUE TO return a `429 Too Many Requests` response

---

## Bug Condition (Pseudocode)

### Bug Condition Function

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type PreLoginRequest
  OUTPUT: boolean

  // Bug is triggered when a database or service error occurs inside the pre-login handler
  // and the thrown error is NOT an instance of AppError
  RETURN (
    X causes db.query() OR getBranchesForUser() to throw a non-AppError exception
  )
END FUNCTION
```

### Property: Fix Checking

```pascal
// Property: Fix Checking — structured error response on DB/service failure
FOR ALL X WHERE isBugCondition(X) DO
  result ← preLogin'(X)
  ASSERT result.statusCode IN {500, 503}
  ASSERT result.body.error IS NOT NULL
  ASSERT result.body.message IS NOT NULL
  ASSERT result.body.requestId IS NOT NULL
  ASSERT no_unhandled_crash(result)
END FOR
```

### Property: Preservation Checking

```pascal
// Property: Preservation Checking — non-buggy inputs unchanged
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT preLogin(X) = preLogin'(X)
END FOR
```
