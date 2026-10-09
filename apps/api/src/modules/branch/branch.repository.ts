import { sql } from 'kysely';
import type { Queryable } from '../../db/tx.js';
import { toBranchRecord } from './branch.mapper.js';
import type { BranchChanges, BranchDependency, BranchRecord, NewBranch } from './branch.types.js';

// Branches are the top of the scope hierarchy, so these queries take no
// branch scope; the service decides who may change which branch.
// Tenant scope arrives with tenancy (#13).

const COLUMNS = ['id', 'name', 'address', 'contact_info', 'operating_hours', 'is_active', 'created_at'] as const;

export async function findById(q: Queryable, id: number): Promise<BranchRecord | undefined> {
  const row = await q.selectFrom('branches').select(COLUMNS).where('id', '=', id).executeTakeFirst();
  return row && toBranchRecord(row);
}

export async function list(
  q: Queryable,
  filter: { isActive?: boolean },
  page: { limit: number; offset: number },
): Promise<{ items: BranchRecord[]; total: number }> {
  let query = q.selectFrom('branches');
  if (filter.isActive !== undefined) query = query.where('is_active', '=', filter.isActive);

  const [rows, count] = await Promise.all([
    query.select(COLUMNS).orderBy('name').limit(page.limit).offset(page.offset).execute(),
    query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toBranchRecord), total: Number(count.count) };
}

export async function insert(q: Queryable, branch: NewBranch): Promise<BranchRecord> {
  const row = await q
    .insertInto('branches')
    .values({
      name: branch.name,
      address: branch.address,
      contact_info: JSON.stringify(branch.contactInfo),
      operating_hours: JSON.stringify(branch.operatingHours),
      is_active: true,
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return toBranchRecord(row);
}

/** Changes only the fields given. Undefined when the branch does not exist. */
export async function update(q: Queryable, id: number, changes: BranchChanges): Promise<BranchRecord | undefined> {
  const values = {
    ...(changes.name !== undefined && { name: changes.name }),
    ...(changes.address !== undefined && { address: changes.address }),
    ...(changes.contactInfo !== undefined && { contact_info: JSON.stringify(changes.contactInfo) }),
    ...(changes.operatingHours !== undefined && { operating_hours: JSON.stringify(changes.operatingHours) }),
  };
  if (Object.keys(values).length === 0) return findById(q, id);
  const row = await q
    .updateTable('branches')
    .set(values)
    .where('id', '=', id)
    .returning(COLUMNS)
    .executeTakeFirst();
  return row && toBranchRecord(row);
}

/** False when the branch does not exist. */
export async function setActive(q: Queryable, id: number, isActive: boolean): Promise<boolean> {
  const result = await q.updateTable('branches').set({ is_active: isActive }).where('id', '=', id).executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

/** False when the branch does not exist. */
export async function remove(q: Queryable, id: number): Promise<boolean> {
  const result = await q.deleteFrom('branches').where('id', '=', id).executeTakeFirst();
  return result.numDeletedRows > 0n;
}

/**
 * Records that keep the branch from being deleted, by kind; kinds with none
 * are left out. Staff assignments would cascade, but are kept on purpose; the
 * other tables reference the branch without ON DELETE, so the database
 * refuses the delete while any of their rows exist.
 */
export async function dependenciesOf(q: Queryable, id: number): Promise<BranchDependency[]> {
  const { rows } = await sql<{ type: string; count: string }>`
    SELECT type, count FROM (VALUES
      ('staff_assignments',     (SELECT COUNT(*) FROM staff_branch_roles WHERE branch_id = ${id})),
      ('locations',             (SELECT COUNT(*) FROM locations WHERE branch_id = ${id})),
      ('bank_accounts',         (SELECT COUNT(*) FROM bank_accounts WHERE branch_id = ${id})),
      ('customers',             (SELECT COUNT(*) FROM customers WHERE branch_id = ${id})),
      ('orders',                (SELECT COUNT(*) FROM orders WHERE branch_id = ${id})),
      ('pos_transactions',      (SELECT COUNT(*) FROM transactions WHERE branch_id = ${id})),
      ('returns',               (SELECT COUNT(*) FROM returns WHERE branch_id = ${id})),
      ('exchanges',             (SELECT COUNT(*) FROM exchanges WHERE branch_id = ${id})),
      ('purchase_orders',       (SELECT COUNT(*) FROM purchase_orders WHERE branch_id = ${id} OR receiving_branch_id = ${id})),
      ('supplier_payments',     (SELECT COUNT(*) FROM supplier_payments WHERE branch_id = ${id})),
      ('supplier_credit_notes', (SELECT COUNT(*) FROM supplier_credit_notes WHERE branch_id = ${id})),
      ('receivables',           (SELECT COUNT(*) FROM receivables WHERE branch_id = ${id})),
      ('financial_transactions',(SELECT COUNT(*) FROM financial_transactions WHERE branch_id = ${id}))
    ) AS d(type, count)
    WHERE count > 0`.execute(q);
  return rows.map((r) => ({ type: r.type, count: Number(r.count) }));
}
