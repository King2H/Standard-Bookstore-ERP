# ADR-0003: Hybrid tenancy with `tenant_id` and row-level security in all deployments

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decision owner:** King2H
- **Related:** issues #12, #13, `docs/v2/architecture.md` §5

## Context

Customers will first run the system on-premise (one installation per customer, possibly with
unreliable internet). Later, as connectivity improves, a shared SaaS deployment is expected.
v1 has no tenant concept, and branch filtering is applied by hand in each endpoint, which
caused a real leak: `GET /api/orders` without a `branchId` returns every branch's orders (#12).

## Decision

1. **Hybrid tenancy:** one codebase that runs on-premise (exactly one tenant) and as SaaS
   (many tenants) without code changes.
2. Every business table gets a `tenant_id`. Branch-owned tables also keep `branch_id`.
   Hierarchy: tenant → branch → location.
3. **Scope comes from the authenticated context**, never from client input. One scope
   middleware builds `ctx = { tenantId, branchId, staffId, permissions }`.
4. **Repositories require scope parameters** for tenant- and branch-owned tables.
5. **PostgreSQL row-level security (RLS) is enabled in all deployments**, on-premise
   included. Policies compare `tenant_id` with `current_setting('app.tenant_id')`, which the
   Unit of Work sets for each transaction (ADR-0005).
6. The application connects as a role that is subject to RLS. Migrations run as a separate
   owner role.
7. Existing v1 databases are migrated by creating tenant 1 and backfilling `tenant_id`.

## Consequences

**Positive**
- Two independent safety layers: a missed filter in code still cannot leak another tenant's
  data.
- Moving a customer from on-premise to SaaS is a deployment task, not a rewrite.
- One code path to test and secure (owner decision: RLS everywhere).

**Negative / costs**
- A schema migration touching every business table.
- RLS adds a small query-planning cost and must be considered in indexes
  (`tenant_id` first in composite indexes).
- Tests must set the tenant context; connection pooling must not leak it between requests
  (`SET LOCAL` inside the transaction).

## Alternatives considered

- **Single-tenant only (installation per customer):** simplest, but SaaS would need a
  rewrite later.
- **Database or schema per tenant:** strong isolation, but much harder to migrate, back up and
  operate at scale.
- **Application-level filtering only, without RLS:** less work, but one forgotten filter leaks
  data, which is exactly the v1 failure mode.
