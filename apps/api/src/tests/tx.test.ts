import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from 'kysely';
import { db } from '../db/index.js';
import { kysely } from '../db/kysely.js';
import { withTransaction, type Queryable } from '../db/tx.js';

// system_config rows with a unique key prefix, removed after the file.
const prefix = `uow_test_${randomUUID().slice(0, 8)}_`;
const key = (name: string) => `${prefix}${name}`;

// A repository-style function: it only sees a Queryable, never a transaction.
async function insertConfig(q: Queryable, k: string): Promise<void> {
  await q.insertInto('system_config').values({ key: k, value: JSON.stringify(true), updated_by: 1 }).execute();
}

async function configExists(q: Queryable, k: string): Promise<boolean> {
  const row = await q.selectFrom('system_config').select('key').where('key', '=', k).executeTakeFirst();
  return row !== undefined;
}

afterAll(async () => {
  await kysely.deleteFrom('system_config').where('key', 'like', `${prefix}%`).execute();
});

describe('withTransaction', () => {
  it('commits when the function resolves, and returns its result', async () => {
    const result = await withTransaction({}, async (tx) => {
      await insertConfig(tx, key('commit'));
      return 'done';
    });

    expect(result).toBe('done');
    expect(await configExists(kysely, key('commit'))).toBe(true);
  });

  it('rolls back everything and rethrows when the function throws', async () => {
    const failure = new Error('stock check failed');

    await expect(
      withTransaction({}, async (tx) => {
        await insertConfig(tx, key('rollback'));
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await configExists(kysely, key('rollback'))).toBe(false);
  });

  it('runs v1 pg code on the same transaction through `client`', async () => {
    await expect(
      withTransaction({}, async (tx, client) => {
        await client.query(
          `INSERT INTO system_config (key, value, updated_by) VALUES ($1, 'true', 1)`,
          [key('legacy')],
        );
        // Visible to Kysely inside the transaction: it is the same connection.
        expect(await configExists(tx, key('legacy'))).toBe(true);
        throw new Error('undo both');
      }),
    ).rejects.toThrow('undo both');

    expect(await configExists(kysely, key('legacy'))).toBe(false);
  });

  it('sets the tenant only for the duration of the transaction', async () => {
    const inside = await withTransaction({ tenantId: 42 }, async (tx) => {
      const { rows } = await sql<{ tenant: string }>`SELECT current_setting('app.tenant_id', true) AS tenant`.execute(tx);
      return rows[0].tenant;
    });
    expect(inside).toBe('42');

    const { rows } = await sql<{ tenant: string | null }>`SELECT current_setting('app.tenant_id', true) AS tenant`.execute(kysely);
    expect(rows[0].tenant ?? '').toBe('');
  });

  it('runs at the requested isolation level, and at the default otherwise', async () => {
    const level = (ctx: Parameters<typeof withTransaction>[0]) =>
      withTransaction(ctx, async (tx) => {
        const { rows } = await sql<{ level: string }>`SELECT current_setting('transaction_isolation') AS level`.execute(tx);
        return rows[0].level;
      });
    expect(await level({ isolationLevel: 'repeatable read' })).toBe('repeatable read');
    expect(await level({})).toBe('read committed');
  });

  it('refuses a nested transaction instead of committing the outer one early', async () => {
    await expect(
      withTransaction({}, async (tx) => {
        await insertConfig(tx, key('nested'));
        await tx.transaction().execute(async () => {});
      }),
    ).rejects.toThrow('calling the transaction method for a Transaction is not supported');

    expect(await configExists(kysely, key('nested'))).toBe(false);
  });

  it('returns the connection to the pool, also after an error', async () => {
    await withTransaction({}, async () => undefined);
    await withTransaction({}, async () => {
      throw new Error('fail');
    }).catch(() => undefined);

    // Every connection the pool has opened is idle again: none was leaked.
    expect(db.totalCount - db.idleCount).toBe(0);
  });
});
