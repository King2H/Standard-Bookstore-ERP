import { sql } from 'kysely';
import type { LifecycleStatus } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import { toServiceRecord, type ServiceRow } from './services.mapper.js';
import type { ServiceFields, ServiceFilter, ServiceRecord } from './services.types.js';

// The only SQL of the services list (A6). A service belongs to the shop; a
// branch's own fee is read for the branch the caller names.

type Page = { limit: number; offset: number };

function selectServices(q: Queryable, branchId: number) {
  return q
    .selectFrom('services as s')
    .leftJoin('book_formats as f', 'f.id', 's.format_id')
    .leftJoin('service_branch_fees as bf', (join) => join.onRef('bf.service_id', '=', 's.id').on('bf.branch_id', '=', branchId))
    .select([
      's.id', 's.code', 's.name', 's.kind', 's.format_id', 'f.label as format_label', 's.fee', 'bf.fee as branch_fee',
      's.standard_cost', 's.discountable', 's.turnaround_days', 's.status', 's.created_at', 's.updated_at',
    ]);
}

export async function findService(q: Queryable, id: number, branchId: number): Promise<ServiceRecord | undefined> {
  const row = await selectServices(q, branchId).where('s.id', '=', id).executeTakeFirst();
  return row && toServiceRecord(row as ServiceRow);
}

export async function listServices(
  q: Queryable,
  branchId: number,
  filter: ServiceFilter,
  page: Page,
): Promise<{ items: ServiceRecord[]; total: number }> {
  let query = selectServices(q, branchId);
  if (filter.q) {
    const pattern = `%${filter.q.toLowerCase()}%`;
    query = query.where((eb) => eb.or([eb(sql`lower(s.name)`, 'like', pattern), eb(sql`lower(s.code)`, 'like', pattern)]));
  }
  if (filter.statuses) query = query.where('s.status', 'in', filter.statuses);
  const [rows, count] = await Promise.all([
    query.orderBy('s.name').orderBy('s.id').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map((r) => toServiceRecord(r as ServiceRow)), total: Number(count.count) };
}

export async function formatExists(q: Queryable, formatId: number): Promise<boolean> {
  return (await q.selectFrom('book_formats').select('id').where('id', '=', formatId).executeTakeFirst()) !== undefined;
}

function columns(s: ServiceFields) {
  return {
    code: s.code,
    name: s.name,
    kind: s.kind,
    format_id: s.formatId,
    fee: s.fee.toFixed(2),
    standard_cost: s.standardCost.toFixed(2),
    discountable: s.discountable,
    turnaround_days: s.turnaroundDays,
  };
}

export async function insertService(q: Queryable, s: ServiceFields, staffId: number): Promise<number> {
  const row = await q
    .insertInto('services')
    .values({ ...columns(s), created_by: staffId, updated_by: staffId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** False when there is no such service. */
export async function updateService(q: Queryable, id: number, s: ServiceFields, staffId: number): Promise<boolean> {
  const res = await q
    .updateTable('services')
    .set({ ...columns(s), updated_by: staffId, updated_at: sql`now()` })
    .where('id', '=', id)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

/** The service's status, locked until the transaction ends. */
export async function lockStatus(q: Queryable, id: number): Promise<LifecycleStatus | undefined> {
  const row = await q.selectFrom('services').select('status').where('id', '=', id).forUpdate().executeTakeFirst();
  return row?.status as LifecycleStatus | undefined;
}

export async function setStatus(q: Queryable, id: number, status: LifecycleStatus, staffId: number): Promise<void> {
  await q.updateTable('services').set({ status, updated_by: staffId, updated_at: sql`now()` }).where('id', '=', id).execute();
}

export async function setBranchFee(q: Queryable, serviceId: number, branchId: number, fee: string, staffId: number): Promise<void> {
  await q
    .insertInto('service_branch_fees')
    .values({ service_id: serviceId, branch_id: branchId, fee, updated_by: staffId })
    .onConflict((oc) => oc.columns(['service_id', 'branch_id']).doUpdateSet({ fee, updated_by: staffId, updated_at: sql`now()` }))
    .execute();
}

/** The fee the branch had, if any. */
export async function removeBranchFee(q: Queryable, serviceId: number, branchId: number): Promise<string | undefined> {
  const row = await q
    .deleteFrom('service_branch_fees')
    .where('service_id', '=', serviceId)
    .where('branch_id', '=', branchId)
    .returning('fee')
    .executeTakeFirst();
  return row?.fee;
}
