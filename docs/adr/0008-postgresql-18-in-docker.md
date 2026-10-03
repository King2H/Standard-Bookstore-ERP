# ADR-0008: PostgreSQL 18, run in Docker for development

- **Status:** Accepted
- **Date:** 2026-10-02
- **Decision owner:** King2H
- **Related:** issue #8, PR #36, PR #40, `docs/development.md`

## Context

v1 was developed and deployed on PostgreSQL 16. The owner's PC also had a native PostgreSQL 18
installation that the project was not using. v2 is a new major version and the moment to choose
the database version deliberately, based on industry practice rather than on what existing
installations happen to run.

## Decision

1. **v2 targets PostgreSQL 18**: the newest major version, supported until November 2030.
   `release/1.x` stays on PostgreSQL 16.
2. **Development uses PostgreSQL in Docker** (`postgres:18-alpine`) rather than a native
   install, so every environment runs the same Linux build with the same collation rules.
3. The development database listens on **host port 5433**, so it never collides with a
   native PostgreSQL on 5432.
4. **One Docker volume per major version** (`pgdata18`). PostgreSQL 18 images keep data under
   `/var/lib/postgresql/18/docker`, so the volume mounts `/var/lib/postgresql`. A future major
   version gets a new volume and an explicit upgrade (`pg_upgrade` or dump and restore).
5. Cloud sessions (session-start hook) and CI use PostgreSQL 18 on port 5433 as well.

## Consequences

**Positive**
- The same database version and behaviour on every PC, in cloud sessions, in CI and in
  production.
- Five years of support from the start of v2.
- Clean, fast database resets for tests.

**Negative / costs**
- v1 → v2 customer upgrades include a PostgreSQL 16 → 18 upgrade, planned as part of the v2
  upgrade procedure (#31).
- Developers need Docker Desktop running.

## Alternatives considered

- **Stay on PostgreSQL 16:** support ends in November 2028, early in v2's life.
- **Native PostgreSQL on each developer PC:** versions and settings drift; Windows collations
  sort text differently from the Linux servers customers run.
