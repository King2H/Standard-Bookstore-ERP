# ADR-0002: Kysely for data access, no ORM

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decision owner:** King2H
- **Related:** issue #18, ADR-0001, ADR-0005

## Context

v1 uses raw SQL strings through `pg`. That is explicit and fast, but typos in column names and
wrong result shapes are only found at runtime, and results are mapped by hand in each service.
v1 also has 49 hand-written migrations, and complex SQL for costing and reporting that an ORM
would express poorly.

## Decision

1. Repositories use **Kysely** (a type-safe SQL query builder) on top of the existing `pg` pool.
2. Database types are **generated from the real schema** (for example with `kysely-codegen`)
   and checked in CI, so code and schema cannot drift apart unnoticed.
3. **Migrations stay with `node-pg-migrate`.** Kysely is not used for schema changes.
4. Raw SQL remains allowed inside repositories for queries Kysely cannot express well
   (complex reports), using Kysely's `sql` template so parameters stay bound.
5. No ORM (no entity classes that load or save themselves).

## Consequences

**Positive**
- Column and table mistakes become compile errors.
- Query results are typed end to end.
- Small, incremental adoption: one module at a time, alongside existing `pg` code.

**Negative / costs**
- A new dependency and a code-generation step.
- Developers need to learn Kysely's API, which stays close to SQL.

## Alternatives considered

- **Raw `pg` in repositories:** no new dependency, but no compile-time checks.
- **Prisma:** owns its own schema and migrations, which would compete with the 49 existing
  migrations; weaker for complex SQL.
- **Drizzle ORM:** closer to SQL than Prisma, but it also prefers to own the schema and
  migrations. Kysely fits a "SQL first, migrations already exist" codebase better.
