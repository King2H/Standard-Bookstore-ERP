import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tenant the current work runs for (ADR-0003, #13). A request takes it
 * from the signed-in account, a background job from the tenant it is
 * working through; the database pool hands it to every connection as
 * `app.tenant_id` (db/index.ts), where the tenant_id column default and,
 * later, row-level security read it.
 *
 * It is never taken from client input.
 */
const store = new AsyncLocalStorage<{ tenantId: number }>();

/** Tenant for work outside any context. Only the test setup sets it, for test fixtures written straight to the database. */
let fallbackTenant: number | undefined;

/** Runs `fn`, and everything it starts, for the tenant. */
export function runInTenant<T>(tenantId: number, fn: () => T): T {
  return store.run({ tenantId }, fn);
}

/** The tenant of the current work, or undefined outside any. */
export function currentTenant(): number | undefined {
  return store.getStore()?.tenantId ?? fallbackTenant;
}

/** Tests only: the tenant for fixtures written outside a request or job. */
export function setFallbackTenant(tenantId: number | undefined): void {
  fallbackTenant = tenantId;
}
