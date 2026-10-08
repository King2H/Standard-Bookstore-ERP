import { Kysely, PostgresDialect, sql } from 'kysely';
import type { PoolClient } from 'pg';
import { db } from './index.js';
import type { DB } from './types.generated.js';

/**
 * What repositories run their SQL on: the shared `kysely` instance, or the `tx`
 * handed out by withTransaction. Repository functions take it as their first
 * argument, so the same function works inside and outside a Unit of Work
 * (ADR-0005).
 */
export type Queryable = Kysely<DB>;

/** Request context for a Unit of Work. */
export interface TxContext {
  /**
   * Tenant for row-level security (ADR-0003). Set with set_config(..., true),
   * so it lasts only until the end of the transaction. Tenants arrive in M4
   * (#13); until then it is optional.
   */
  tenantId?: number;
  /**
   * Isolation level, when READ COMMITTED (PostgreSQL's default) is not
   * enough, e.g. a use case that must see one consistent snapshot of stock.
   */
  isolationLevel?: 'repeatable read' | 'serializable';
}

/**
 * Runs `fn` in one database transaction: commits if it resolves, rolls back
 * and rethrows if it throws. This is the only way to open a transaction in
 * v2 code; services own the boundary, repositories just use `tx`.
 *
 * `client` is the same connection as `tx`. It exists only so services moved
 * to v2 can still call v1 functions that take a pg PoolClient inside the same
 * transaction, while modules migrate one at a time (M5, #21). Don't use it
 * for new SQL.
 */
export async function withTransaction<T>(
  ctx: TxContext,
  fn: (tx: Queryable, client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    // Kysely runs BEGIN/COMMIT/ROLLBACK on this connection, and its Transaction
    // refuses a nested transaction() instead of committing the outer one early.
    const transaction = kyselyOn(client).transaction();
    return await (ctx.isolationLevel ? transaction.setIsolationLevel(ctx.isolationLevel) : transaction)
      .execute(async (tx) => {
        if (ctx.tenantId !== undefined) {
          await sql`SELECT set_config('app.tenant_id', ${String(ctx.tenantId)}, true)`.execute(tx);
        }
        return fn(tx, client);
      });
  } finally {
    client.release();
  }
}

/** A Kysely instance whose every query runs on one already-checked-out connection. */
function kyselyOn(client: PoolClient): Queryable {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: {
        options: {},
        connect: async () => ({
          query: client.query.bind(client) as PoolClient['query'],
          // The connection belongs to withTransaction, which releases it.
          release: () => {},
        }),
        end: async () => {},
      },
    }),
  });
}
