# ADR-0005: Unit of Work and transactional outbox

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decision owner:** King2H
- **Related:** issues #14, #20, ADR-0002, ADR-0003

## Context

ERP operations span several modules: a sale changes the order, inventory and receivables
together, and must succeed or fail as a whole. In v1, 19 files write `BEGIN`/`COMMIT` by hand,
and only 7 functions accept a transaction client. When one module calls another, the second
call often runs outside the first one's transaction.

## Decision

1. **Unit of Work:** `withTransaction(ctx, async (tx) => { … })` in `db/tx.ts` is the only
   way to start a transaction. It:
   - opens the transaction;
   - sets the tenant for row-level security with `SET LOCAL app.tenant_id` (ADR-0003);
   - commits on success and rolls back on any error.
2. Every repository function takes a **`Queryable`** (the database or a transaction) as its
   first argument, so the same function works inside or outside a Unit of Work.
3. **Services own the transaction boundary.** Controllers and repositories never open
   transactions.
4. **Transactional outbox:** events (notifications, webhooks) are written to the `outbox`
   table inside the same transaction as the change, and delivered afterwards by a poller
   (`FOR UPDATE SKIP LOCKED`). An event is never sent for a change that was rolled back.
5. Kept from v1: idempotency keys on money-moving endpoints; optimistic locking (version
   column) on stock rows; `SELECT … FOR UPDATE` where a read-then-write must be atomic.

## Consequences

**Positive**
- Cross-module operations are atomic by construction.
- Transaction handling exists in one place instead of nineteen.
- Tenant context is always set, so row-level security cannot be bypassed by forgetting it.

**Negative / costs**
- Every repository signature changes during the migration.
- Long-running work must not be done inside a transaction; it goes to the outbox or a job.

## Alternatives considered

- **Manual `BEGIN`/`COMMIT` per service (v1):** error-prone and not composable.
- **Async-context transactions (e.g. AsyncLocalStorage):** less parameter passing, but
  implicit; mistakes are harder to see in review. An explicit `tx` parameter was preferred.
- **Distributed sagas:** unnecessary inside one database and one deployable.
