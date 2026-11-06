# Bookstore ERP v2: roadmap

Status: **accepted** by the owner on 2026-10-03 (issue #11); updated as work progresses
Owner: King2H · Last updated: 2026-11-06

This roadmap orders the v2 backlog (epics #2–#6) into milestones, from the completed
Phase 0 to the `v2.0.0` release. Each milestone is a GitHub Milestone with the same name.
Day-to-day progress is tracked in issue #37.

**How to read it**
- Milestones are done **in order**. M6 (web app) can run in parallel from M3 onwards.
- **Exception:** M5 (module migration) comes before M4 (tenancy), because tenancy is enforced
  in repositories and most modules have none yet (owner decision, 2026-10-08). The
  milestone numbers stay as they are, to match the GitHub Milestones.
- **Dates are not fixed.** The owner can set target dates on the GitHub Milestones at any
  time. Size is given in pull requests, because every change is one reviewed PR.
- Each milestone has **exit criteria**. It is closed only when all of them are met.
- Pre-release tags follow ADR-0007: they are created only if a build is handed to someone
  outside development at that point.

---

## Overview

| # | Milestone | Issues | Size | Possible pre-release |
|---|---|---|---|---|
| M0 | Phase 0: design and workspace | #7, #8, #9, #10, #11 | done | — |
| M1 | Quality gates | #29, #30, #16, #47 | ~4 PRs | — |
| M2 | Core infrastructure | #18, #14, #15, #17 | ~5 PRs | — |
| M3 | Reference modules and scope | #19, #20, #12, #38 | ~5 PRs | — |
| M5 | Module migration | #21, #22, #66, #68, #69, #70, #72 | ~28 PRs | — |
| M4 | Tenancy (after M5) | #13 | ~4 PRs | `v2.0.0-alpha.1` |
| M6 | Web app | #23 | ~20 PRs (parallel from M3) | `v2.0.0-alpha.2` |
| M7 | On-premise release (owner decision a, 2026-11-06) | #31, #244, #245, #32, #33, #246, #247 | ~12 PRs + a pilot | `v2.0.0` |
| M8 | Multi-tenant | #24, #27, #28, #248 | ~8 PRs | `v2.1.0` |

```mermaid
flowchart LR
  M0[M0 Phase 0 ✓] --> M1[M1 Quality gates] --> M2[M2 Core infrastructure] --> M3[M3 Reference modules + scope] --> M5[M5 Module migration] --> M4[M4 Tenancy] --> M7[M7 On-premise release v2.0.0] --> M8[M8 Multi-tenant v2.1]
  M3 --> M6[M6 Web app] --> M7
```

---

## M0: Phase 0, design and workspace (done)

`CLAUDE.md` and project settings (#7). PostgreSQL 18 local setup (#8). Node.js 24 (PR #39).
Cloud startup hook (PR #40). Vision and architecture (#9). ADRs 0001–0011 (#10). This roadmap (#11).

## M1: Quality gates

**Why first:** every later PR changes structure without changing behaviour. Automated checks
on each PR are what make that safe.

| Order | Issue | Outcome |
|---|---|---|
| 1 | #29 CI pipeline | GitHub Actions on every PR: install, lint, typecheck, API tests on PostgreSQL 18, web tests, build. Branch protection on `main` requires green CI. |
| 2 | #30 Test isolation | Separate test database, created and migrated by the test run; tests no longer depend on order or leave data behind. (The bank-account tests already run with the module switched on, since PR #44.) |
| 3 | #16 Security hardening | Fail-fast on invalid or placeholder secrets; CORS fails closed; rate limiter trusts only configured proxies; security headers; production `npm audit` clean. |
| 4 | #47 Dev tooling upgrades | Vitest (API), typescript-eslint and node-pg-migrate on current majors, clearing their audit advisories. |

**Exit criteria:** CI green and required on `main`; the full suite passes on a fresh database
with zero unexpected failures; no high or critical advisories outside the web toolchain, which is
upgraded in M6 step 1.

## M2: Core infrastructure

**Why now:** the building blocks every refactored module needs.

| Order | Issue | Outcome |
|---|---|---|
| 1 | #18 Kysely + money helper | Kysely on the existing pool; generated database types checked in CI; one money helper (ADR-0002). |
| 2 | #14 Unit of Work | `withTransaction(ctx, fn)` and `Queryable` (ADR-0005). |
| 3 | #15 Shared contracts | zod schemas in `packages/shared`, `validate(schema)` middleware, `/api/v1` routing, error envelope, OpenAPI generation (ADR-0004). |
| 4 | #17 Remove runtime schema checks | No `information_schema` checks or DDL at runtime; migrations are the only schema source. |

**Exit criteria:** infrastructure merged with unit tests; existing API tests unchanged and green.

## M3: Reference modules and scope

**Why now:** proves the architecture on one simple and one complex module before it is
repeated everywhere.

| Order | Issue | Outcome |
|---|---|---|
| 1 | #19 Suppliers pilot | First module in the full layered structure; becomes the reference for all others. |
| 2 | #12 Scope enforcement | Scope middleware; branch scope from the login only; repositories require scope; the `GET /api/orders` leak closed with a regression test. |
| 3 | #20 Orders refactor | Cross-module transaction (orders + inventory + receivables) in one Unit of Work. |
| 4 | #38 Forced password change on the server | Enforced by the API on every request; cannot be bypassed by branch switch or reload. |

**Exit criteria:** Suppliers and Orders follow ADR-0001 fully; scope and password-change
regression tests pass.

## M5: Module migration

One PR per module (#21), each following the Suppliers/Orders pattern (controller, service,
policy, repository, shared contracts, OpenAPI, `Money`) and passing its existing tests. Large
modules (inventory, catalog, procurement, auth) take two PRs. Modules go in dependency order,
so each one builds on modules already migrated (owner decision, 2026-10-08):

| Order | Modules |
|---|---|
| 1 | config, location, branch, audit logs, notifications, financial transactions |
| 2 | customer, inventory, catalog |
| 3 | receivables, payments (installment plans retired), pos, returns, procurement, exchanges |
| 4 | auth, bank accounts |

Issues found earlier get their own small PR right after the module they belong to: #72 after
location, #66 after procurement, #68, #69 and #70 after payments and pos. Then the reports
service is split into read-model queries (#22).

**Exit criteria:** no SQL outside repositories; no service over a few hundred lines; every
repository function takes an explicit scope, ready for tenancy (M4).

## M4: Tenancy (after M5)

**Why after M5:** scope is enforced in repositories, so they must exist first (ADR-0003).
The plan and the schema decisions are recorded on #13.

| Order | Issue | Outcome |
|---|---|---|
| 1 | #13 part 1 | `tenants` table; `tenant_id` on business tables; backfill existing data as tenant 1. |
| 2 | #13 part 2 | Tenant in the token and scope; tenant set for every query of a request; background workers run per tenant. |
| 3 | #13 part 3 | Application role subject to row-level security; RLS policies; cross-tenant isolation tests; setup changes. |
| 4 | #13 part 4 | Repositories take the tenant explicitly. |

**Exit criteria:** isolation tests prove that one tenant cannot read or change another's data,
even with an application filter removed.
**Possible pre-release:** `v2.0.0-alpha.1` (foundation complete) if a build goes to testers.

## M6: Web app (parallel from M3)

| Order | Step |
|---|---|
| 1 | React 19, current Vite and Vitest, and React Router: one URL per page, with permission route guards (ADR-0011) |
| 1b | Tailwind CSS 4. Together with step 1, clears the web toolchain's audit advisories |
| 2 | App shell, typed API client on `/api/v1`, query-key factories; then remove the deprecated `/api` alias (#15) |
| 3 | Features migrated one per PR, following the API modules already refactored (Suppliers first) |

**Exit criteria:** every page reachable by URL; no `fetch` in pages; forms use the shared schemas.
**Possible pre-release:** `v2.0.0-alpha.2`.

## M7: On-premise release (`v2.0.0`)

Owner decision a, 2026-11-06, after an assessment of what a shop needs before it can run v2
without a developer: the workflows were complete and consistent, but a shop could not be
installed, backed up or upgraded. `v2.0.0` is the single-shop on-premise release; multi-tenant
follows in M8. It starts once the UAT audit's owner decisions are done (#225: #249).

| Issue | Outcome | Release gate |
|---|---|---|
| #31 | Install bundle: production image, the web app served, secrets generated at setup, HTTPS on the shop's network, an install guide for a clean Windows PC | A non-developer installs the shop in under an hour; a second PC signs in over HTTPS |
| #244 | Backups and restore, with the encryption key | A backup restored on a second PC reads the same (`db:check` 0 errors) |
| #245 | Upgrades and rollback; v1 → v2 | Upgrade and rollback with no data lost |
| #32 | Structured logging with the request ID; liveness and readiness | |
| #33 | E2E tests of the key journeys in CI; one version source; release process | The journeys pass in CI |
| #246 | Bulk import and export: catalog, opening stock, customers | A shop's lists exported and imported give the same stock value and counts |
| #247 | Tax: off by default, or a configured rate on receipts and reports | |

**Exit criteria:** the release gates above, then a 2–4 week pilot in a real shop with no blocker
and no data inconsistency.
**Release:** **`v2.0.0`**.

## M8: Multi-tenant (`v2.1`)

| Issue | Outcome |
|---|---|
| #24 | Configuration hierarchy with a tenant level (ADR-0006) |
| #27 | Module licensing and feature flags; bank accounts re-enabled behind a flag |
| #28 | Tenant provisioning for SaaS, webhooks, accounting export |
| #248 | Several API instances: a locked job scheduler, a shared sign-in limit, metrics and tracing |

**Exit criteria:** a new tenant can be set up through configuration only, on a deployment with
several API instances.

## When a customer needs it

#25 (payment method registry), #26 (currency per tenant, English and Amharic UI, configurable
number series), #88 (manual ledger adjustments), #101 (payment terms), #106 (purchase orders
in a foreign currency), #149 (transfer references on money going out).

---

## Changing this roadmap

The roadmap changes when reality does. Changes to milestone order or scope are made in a PR
to this file, approved by the owner, and reflected in the GitHub Milestones and in #37.
