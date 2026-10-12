# ADR-0012: The tenant scope travels with the database connection

- **Status:** Accepted
- **Date:** 2026-10-12
- **Decision owner:** King2H
- **Related:** issue #13; supersedes rule 4 of ADR-0003 for the tenant scope; `docs/v2/architecture.md` §5

## Context

ADR-0003 rule 4 asks every repository function for a tenant- or branch-owned table to take the
scope as a parameter. By the time tenancy was built (#13), the 33 repositories had 329 functions,
and row-level security already kept tenants apart in the database (PR #124), with tests over every
tenant table. Passing a tenant id through every repository and service would have been the largest
change since the module migration, to add a second check of something the database already enforces.
What the code still needed was a guard against work that forgets its tenant, which row-level security
answers with silently empty results instead of an error.

## Decision

1. **The tenant is part of the work, not of each call.** A request runs in the signed-in account's
   tenant, a background job in the tenant `forEachTenant` gives it (`db/tenantContext.ts`). The pool
   hands every connection that tenant as `app.tenant_id`; row-level security and the `tenant_id`
   default read it.
2. **No tenant, no connection.** Database work with no tenant is refused (`NoTenantError`) before it
   reaches the database. Work that needs no tenant names the reason with `runWithoutTenant`: finding
   the tenant of an account signing in, listing tenants for background jobs, checking the database.
   Code review checks every new use of it.
3. **Repositories take no tenant parameter.** They receive a `Queryable` that already carries the
   tenant. The branch scope stays a parameter, as ADR-0003 rule 4 says.
4. **A sweep test keeps it honest.** Every documented endpoint is called with no tenant to fall back
   on, without a token and as a signed-in account; none may reach the database outside a tenant.

## Consequences

**Positive**
- One place enforces the tenant in code (the pool), and the database enforces it again.
- A forgotten tenant fails loudly in development and tests, instead of returning empty results.
- No change to the repositories or services.

**Negative / costs**
- A repository function's signature does not show that it is tenant-scoped; the convention and the
  sweep test carry that.
- Work must not leave its async context (for example a callback registered outside the request);
  such work gets no connection, which the sweep and the tenant-context tests catch.

## Alternatives considered

- **Every repository function takes the tenant (ADR-0003 rule 4 as written):** explicit in every
  signature and testable without a database, but about 6–8 PRs touching every module for a check the
  database already makes.
- **Row-level security only:** no code change, but a forgotten tenant would only show up as missing
  data.
