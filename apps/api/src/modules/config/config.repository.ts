import { sql } from 'kysely';
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
      oc.columns(['tenant_id', 'key']).doUpdateSet((eb) => ({
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

/**
 * What keeps the tenant's currency (#181, owner decision 3a): any sale,
 * order, exchange, return, purchase order (a draft too), supplier payment,
 * ledger entry, receivable, bank account, or stock received at a cost.
 * Amounts are kept as entered, never converted, so none may be relabelled.
 * Returns what holds it, in words, or nothing.
 */
/** Whether PostgreSQL knows the time zone, by its IANA name. */
export async function isKnownTimeZone(q: Queryable, zone: string): Promise<boolean> {
  const { rows } = await sql<{ known: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${zone}) AS known`.execute(q);
  return rows[0].known;
}

export async function findCurrencyHolders(q: Queryable): Promise<string[]> {
  const { rows } = await sql<{ holder: string }>`
    SELECT holder FROM (VALUES
      ('sales', EXISTS (SELECT 1 FROM transactions)),
      ('orders', EXISTS (SELECT 1 FROM orders)),
      ('exchanges', EXISTS (SELECT 1 FROM exchanges)),
      ('returns', EXISTS (SELECT 1 FROM returns)),
      ('purchase orders', EXISTS (SELECT 1 FROM purchase_orders)),
      ('supplier payments', EXISTS (SELECT 1 FROM supplier_payments)),
      ('payments', EXISTS (SELECT 1 FROM financial_transactions)),
      ('receivables', EXISTS (SELECT 1 FROM receivables)),
      ('bank accounts', EXISTS (SELECT 1 FROM bank_accounts)),
      ('cash sessions', EXISTS (SELECT 1 FROM cash_sessions)),
      ('stock at a cost', EXISTS (SELECT 1 FROM inventory_history WHERE unit_cost > 0))
    ) AS h (holder, held)
    WHERE held
  `.execute(q);
  return rows.map((r) => r.holder);
}

/**
 * The shop's currency as an SQL value, read in the statement that stores it:
 * every record names the currency it was made in (#181). ETB when it is not
 * set, as `getBaseCurrency` reads it.
 */
export const SHOP_CURRENCY = sql<string>`COALESCE((SELECT value #>> '{}' FROM system_config WHERE key = 'base_currency'), 'ETB')`;

/** The shop's currency, as `SHOP_CURRENCY` reads it. */
export async function findShopCurrency(q: Queryable): Promise<string> {
  const { rows } = await sql<{ currency: string }>`SELECT ${SHOP_CURRENCY} AS currency`.execute(q);
  return rows[0].currency;
}
