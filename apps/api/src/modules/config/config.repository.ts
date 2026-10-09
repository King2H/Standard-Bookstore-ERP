import type { Queryable } from '../../db/tx.js';
import { toConfigRecord } from './config.mapper.js';
import type { ConfigRecord } from './config.types.js';

// System settings belong to no branch. Branch overrides are read and written
// for the branch the caller passes; the service decides which branch that is.
// Tenant scope arrives with tenancy (#13).

const COLUMNS = ['key', 'value', 'updated_by', 'updated_at'] as const;

export async function findSystemValue(q: Queryable, key: string): Promise<{ value: unknown } | undefined> {
  return q.selectFrom('system_config').select('value').where('key', '=', key).executeTakeFirst();
}

export async function findBranchValue(
  q: Queryable,
  branchId: number,
  key: string,
): Promise<{ value: unknown } | undefined> {
  return q
    .selectFrom('branch_config')
    .select('value')
    .where('branch_id', '=', branchId)
    .where('key', '=', key)
    .executeTakeFirst();
}

export async function listSystem(q: Queryable): Promise<ConfigRecord[]> {
  const rows = await q.selectFrom('system_config').select(COLUMNS).orderBy('key').execute();
  return rows.map(toConfigRecord);
}

export async function listBranch(q: Queryable, branchId: number): Promise<ConfigRecord[]> {
  const rows = await q
    .selectFrom('branch_config')
    .select(COLUMNS)
    .where('branch_id', '=', branchId)
    .orderBy('key')
    .execute();
  return rows.map(toConfigRecord);
}

export async function upsertSystem(
  q: Queryable,
  entry: { key: string; value: unknown; updatedBy: number },
): Promise<ConfigRecord> {
  const row = await q
    .insertInto('system_config')
    .values({ key: entry.key, value: JSON.stringify(entry.value), updated_by: entry.updatedBy })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet((eb) => ({
        value: eb.ref('excluded.value'),
        updated_by: eb.ref('excluded.updated_by'),
        updated_at: eb.fn('now'),
      })),
    )
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return toConfigRecord(row);
}

export async function upsertBranch(
  q: Queryable,
  branchId: number,
  entry: { key: string; value: unknown; updatedBy: number },
): Promise<ConfigRecord> {
  const row = await q
    .insertInto('branch_config')
    .values({ branch_id: branchId, key: entry.key, value: JSON.stringify(entry.value), updated_by: entry.updatedBy })
    .onConflict((oc) =>
      oc.columns(['branch_id', 'key']).doUpdateSet((eb) => ({
        value: eb.ref('excluded.value'),
        updated_by: eb.ref('excluded.updated_by'),
        updated_at: eb.fn('now'),
      })),
    )
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return toConfigRecord(row);
}

/** False when the branch had no override for `key`. */
export async function deleteBranch(q: Queryable, branchId: number, key: string): Promise<boolean> {
  const result = await q
    .deleteFrom('branch_config')
    .where('branch_id', '=', branchId)
    .where('key', '=', key)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}
