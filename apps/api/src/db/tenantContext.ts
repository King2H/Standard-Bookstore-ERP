import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tenant the current work runs for (ADR-0003, #13). A request takes it
 * from the signed-in account, a background job from the tenant it is
 * working through; the database pool hands it to every connection as
 * `app.tenant_id` (db/index.ts), where the tenant_id column default and
 * row-level security read it.
 *
 * It is never taken from client input. Work with no tenant gets no database
 * connection, unless it says why it needs none (runWithoutTenant): the few
 * things done before a tenant is known, or across tenants.
 */
type Work = { tenantId: number } | { withoutTenant: string };

const store = new AsyncLocalStorage<Work>();

/** Tenant for work outside any context. Only the test setup sets it, for test fixtures written straight to the database. */
let fallbackTenant: number | undefined;

/** Runs `fn`, and everything it starts, for the tenant. */
export function runInTenant<T>(tenantId: number, fn: () => T): T {
  return store.run({ tenantId }, fn);
}

/**
 * Runs `fn` with no tenant, for work that needs none: finding the tenant of
 * an account signing in, listing tenants for background jobs, checking the
 * database. Row-level security shows it no tenant's rows.
 */
export function runWithoutTenant<T>(reason: string, fn: () => T): T {
  return store.run({ withoutTenant: reason }, fn);
}

/** The current work, or undefined when it has neither a tenant nor a reason to have none. */
export function currentWork(): Work | undefined {
  const work = store.getStore();
  if (work) return work;
  return fallbackTenant === undefined ? undefined : { tenantId: fallbackTenant };
}

/** Tests only: the tenant for fixtures written outside a request or job. */
export function setFallbackTenant(tenantId: number | undefined): void {
  fallbackTenant = tenantId;
}

/** Database work started with neither a tenant nor a reason to have none: a bug in the code that started it. */
export class NoTenantError extends Error {
  constructor() {
    super(
      'Database work outside a tenant. Requests get one from the signed-in account and background jobs from forEachTenant; ' +
        'work that needs none says why with runWithoutTenant.',
    );
    this.name = 'NoTenantError';
  }
}
