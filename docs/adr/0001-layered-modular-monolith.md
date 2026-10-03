# ADR-0001: Layered architecture in a modular monolith

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decision owner:** King2H
- **Related:** `docs/v2/architecture.md` §3–4, epic #4

## Context

In v1, route handlers and service files mix input parsing, business rules, SQL and transaction
control. Some service files exceed 1,000 lines (`reports.service.ts` has 2,343). One route file
(`auth.routes.ts`) runs SQL directly. Changes are risky because responsibilities are not
separated, and the same rules are implemented in several places.

The system is a single product maintained by a small team. It does not need independent
deployment or scaling of individual modules.

## Decision

1. v2 stays a **modular monolith**: one deployable API, with each business domain in its own
   module under `apps/api/src/modules/<domain>/`.
2. Every module uses the same layers, and each layer calls only the layer below it:
   routes → controller → service → domain/policy → repository → database.
3. Layer rules (checked in code review):
   - Routes only map a URL and middleware to a controller.
   - Controllers turn a validated request into a service call and a response. No business
     rules, no SQL.
   - Services implement one use case each and own the transaction boundary. They never touch
     `req`/`res` and never write SQL.
   - Domain/policy code is pure (no I/O) and unit-tested.
   - Repositories are the **only** code that runs SQL.
4. Modules talk to each other through services (or shared repositories inside one Unit of
   Work), never by reading another module's tables directly from a controller.
5. The web app follows the matching layers: app shell → pages → feature components →
   server-state hooks → API client.

## Consequences

**Positive**
- Each concern has one home, so changes are smaller and easier to review.
- Business rules become pure functions that can be unit-tested without a database.
- New contributors, human or AI, can follow written rules (`CLAUDE.md`, this ADR).

**Negative / costs**
- More files per module, and some mapping code between layers.
- The migration from v1 takes many PRs (#19–#23).

## Alternatives considered

- **Keep the v1 structure:** rejected, because it is the main source of risk and duplication.
- **Microservices:** rejected for v2. It adds network, deployment and data-consistency costs
  with no benefit at the current scale; a well-separated monolith can be split later if ever
  needed.
- **Hexagonal / ports-and-adapters with full dependency inversion:** rejected as more
  abstraction than needed. The chosen layering keeps its main benefit (pure domain logic) with
  less ceremony.
