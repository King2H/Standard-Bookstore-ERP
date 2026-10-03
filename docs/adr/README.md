# Architecture Decision Records

An ADR records one significant decision: the context, what was decided, its consequences and
the alternatives that were rejected. ADRs are the rules that code review checks against.
The overall design they belong to is in [`../v2/architecture.md`](../v2/architecture.md).

**Process**
- A new decision gets the next number and starts as **Proposed** in a PR.
- The owner (King2H) accepts it by merging the PR. Its status becomes **Accepted**.
- Accepted ADRs are not rewritten. To change a decision, write a new ADR that
  **supersedes** the old one, and mark the old one **Superseded by ADR-NNNN**.
- Copy [`template.md`](template.md) to start a new ADR.

| # | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-layered-modular-monolith.md) | Layered architecture in a modular monolith | Accepted | 2026-10-03 |
| [0002](0002-kysely-for-data-access.md) | Kysely for data access, no ORM | Accepted | 2026-10-03 |
| [0003](0003-hybrid-tenancy-with-row-level-security.md) | Hybrid tenancy with `tenant_id` and row-level security in all deployments | Accepted | 2026-10-03 |
| [0004](0004-shared-contracts-and-api-versioning.md) | Shared zod contracts, OpenAPI and `/api/v1` | Accepted | 2026-10-03 |
| [0005](0005-unit-of-work-and-outbox.md) | Unit of Work and transactional outbox | Accepted | 2026-10-03 |
| [0006](0006-configuration-hierarchy.md) | Configuration hierarchy: system → tenant → branch → user | Accepted | 2026-10-03 |
| [0007](0007-branching-merging-and-versioning.md) | Branching, merging, versioning and release ownership | Accepted | 2026-10-03 |
| [0008](0008-postgresql-18-in-docker.md) | PostgreSQL 18, run in Docker for development | Accepted | 2026-10-02 |
| [0009](0009-nodejs-24-lts.md) | Node.js 24 LTS | Accepted | 2026-10-03 |
| [0010](0010-configurable-tax-default-zero.md) | Configurable tax per tenant, default 0% | Accepted | 2026-10-03 |
| [0011](0011-react-19-vite-before-web-migration.md) | React 19, current Vite and React Router before the web migration | Accepted | 2026-10-03 |
