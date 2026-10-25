import { sql } from 'kysely';
import { Money, type LifecycleStatus, type ServiceJobStatus } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import type { PricedServiceLine, SaleRef, SaleServiceLineRecord, ServiceForSale, ServiceJobRecord } from './services.types.js';

// The only SQL of services on a sale (#169 PR 2, A6). A service line belongs
// to one book line, of a counter sale or of an order; its job is the branch's.

/** A service as a sale in `branchId` charges it: the branch's own fee, else the shop's. */
export async function findServiceForSale(q: Queryable, serviceId: number, branchId: number): Promise<ServiceForSale | undefined> {
  const row = await q
    .selectFrom('services as s')
    .leftJoin('service_branch_fees as bf', (join) => join.onRef('bf.service_id', '=', 's.id').on('bf.branch_id', '=', branchId))
    .select(['s.id', 's.code', 's.name', 's.status', 's.fee', 'bf.fee as branch_fee', 's.standard_cost', 's.discountable', 's.turnaround_days'])
    .where('s.id', '=', serviceId)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status as LifecycleStatus,
    fee: Money.of(row.branch_fee ?? row.fee),
    standardCost: Money.of(row.standard_cost),
    discountable: row.discountable,
    turnaroundDays: row.turnaround_days,
  };
}

export async function insertServiceLine(
  q: Queryable,
  bookLine: { posLineId: string } | { orderLineId: string },
  line: PricedServiceLine,
): Promise<number> {
  const row = await q
    .insertInto('sale_service_lines')
    .values({
      transaction_line_item_id: 'posLineId' in bookLine ? bookLine.posLineId : null,
      order_line_item_id: 'orderLineId' in bookLine ? bookLine.orderLineId : null,
      service_id: line.serviceId,
      quantity: line.quantity,
      unit_fee: line.unitFee.toFixed(2),
      discount_pct: line.discountPct.toFixed(4),
      discount_amount: line.discountAmount.toFixed(2),
      line_total: line.lineTotal.toFixed(2),
      standard_cost: line.standardCost.toFixed(2),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

/** Opens a service line's job: ready the sale's day plus the turnaround. */
export async function insertJob(
  q: Queryable,
  job: { serviceLineId: number; branchId: number; customerId: number; jobNumber: string; turnaroundDays: number; staffId: number },
): Promise<number> {
  const row = await q
    .insertInto('service_jobs')
    .values({
      service_line_id: job.serviceLineId,
      branch_id: job.branchId,
      customer_id: job.customerId,
      job_number: job.jobNumber,
      ready_date: sql<string>`CURRENT_DATE + ${job.turnaroundDays}::integer`,
      created_by: job.staffId,
      updated_by: job.staffId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

function selectLines(q: Queryable) {
  return q
    .selectFrom('sale_service_lines as sl')
    .innerJoin('services as s', 's.id', 'sl.service_id')
    .leftJoin('service_jobs as j', 'j.service_line_id', 'sl.id')
    .select([
      'sl.id', 'sl.transaction_line_item_id', 'sl.order_line_item_id', 'sl.service_id', 's.code', 's.name', 's.turnaround_days',
      'sl.quantity', 'sl.unit_fee', 'sl.discount_amount', 'sl.line_total', 'sl.standard_cost',
      'j.id as job_id', 'j.job_number', 'j.status as job_status', 'j.customer_id as job_customer_id', 'j.branch_id as job_branch_id',
      'j.updated_at as job_updated_at', sql<string | null>`TO_CHAR(j.ready_date, 'YYYY-MM-DD')`.as('ready_date'),
    ]);
}

type LineRow = Awaited<ReturnType<ReturnType<typeof selectLines>['execute']>>[number];

function toLineRecord(r: LineRow): SaleServiceLineRecord {
  return {
    id: Number(r.id),
    posLineId: r.transaction_line_item_id === null ? null : String(r.transaction_line_item_id),
    orderLineId: r.order_line_item_id === null ? null : String(r.order_line_item_id),
    serviceId: r.service_id,
    serviceCode: r.code,
    serviceName: r.name,
    turnaroundDays: r.turnaround_days,
    quantity: r.quantity,
    unitFee: Money.of(r.unit_fee),
    discountAmount: Money.of(r.discount_amount),
    lineTotal: Money.of(r.line_total),
    standardCost: Money.of(r.standard_cost),
    job: r.job_id === null ? null : {
      id: Number(r.job_id),
      jobNumber: r.job_number as string,
      // The database CHECK constraint limits status to these values.
      status: r.job_status as ServiceJobStatus,
      readyDate: r.ready_date as string,
      customerId: r.job_customer_id as number,
      branchId: r.job_branch_id as number,
      updatedAt: r.job_updated_at as Date,
    },
  };
}

/** The service lines of a counter sale or an order, with their jobs. */
export async function linesOf(q: Queryable, sale: SaleRef): Promise<SaleServiceLineRecord[]> {
  const rows = 'transactionId' in sale
    ? await selectLines(q)
      .innerJoin('transaction_line_items as li', 'li.id', 'sl.transaction_line_item_id')
      .where('li.transaction_id', '=', sale.transactionId)
      .orderBy('sl.id')
      .execute()
    : await selectLines(q)
      .innerJoin('order_line_items as oli', 'oli.id', 'sl.order_line_item_id')
      .where('oli.order_id', '=', sale.orderId)
      .orderBy('sl.id')
      .execute();
  return rows.map(toLineRecord);
}

/** The jobs of a sale's service lines, locked until the transaction ends. */
export async function lockJobsOf(q: Queryable, sale: SaleRef): Promise<Array<{ id: number; status: ServiceJobStatus }>> {
  const lineIds = 'transactionId' in sale
    ? q.selectFrom('sale_service_lines as sl').innerJoin('transaction_line_items as li', 'li.id', 'sl.transaction_line_item_id')
      .select('sl.id').where('li.transaction_id', '=', sale.transactionId)
    : q.selectFrom('sale_service_lines as sl').innerJoin('order_line_items as oli', 'oli.id', 'sl.order_line_item_id')
      .select('sl.id').where('oli.order_id', '=', sale.orderId);
  const rows = await q.selectFrom('service_jobs').select(['id', 'status']).where('service_line_id', 'in', lineIds).orderBy('id').forUpdate().execute();
  return rows.map((r) => ({ id: Number(r.id), status: r.status as ServiceJobStatus }));
}

/** A job of the branch, locked; another branch's is not found. */
export async function lockJob(q: Queryable, id: number, branchId: number): Promise<ServiceJobRecord | undefined> {
  const row = await q
    .selectFrom('service_jobs')
    .select(['id', 'job_number', 'status', 'customer_id', 'branch_id', 'updated_at', sql<string>`TO_CHAR(ready_date, 'YYYY-MM-DD')`.as('ready_date')])
    .where('id', '=', String(id))
    .where('branch_id', '=', branchId)
    .forUpdate()
    .executeTakeFirst();
  return row && {
    id: Number(row.id),
    jobNumber: row.job_number,
    status: row.status as ServiceJobStatus,
    readyDate: row.ready_date,
    customerId: row.customer_id,
    branchId: row.branch_id,
    updatedAt: row.updated_at,
  };
}

export async function setJobStatus(q: Queryable, id: number, status: ServiceJobStatus, staffId: number): Promise<void> {
  await q
    .updateTable('service_jobs')
    .set({ status, updated_by: staffId, updated_at: sql`now()` })
    .where('id', '=', String(id))
    .execute();
}

/** Book lines among `lineIds` that carry a service whose job was not cancelled. */
export async function boundLines(q: Queryable, lines: { posLineIds: string[] } | { orderLineIds: string[] }): Promise<string[]> {
  const ids = 'posLineIds' in lines ? lines.posLineIds : lines.orderLineIds;
  if (ids.length === 0) return [];
  const column = 'posLineIds' in lines ? 'sl.transaction_line_item_id' : 'sl.order_line_item_id';
  const rows = await q
    .selectFrom('sale_service_lines as sl')
    .leftJoin('service_jobs as j', 'j.service_line_id', 'sl.id')
    .select(column)
    .where(column, 'in', ids)
    .where((eb) => eb.or([eb('j.id', 'is', null), eb('j.status', '!=', 'CANCELLED')]))
    .execute();
  return rows.map((r) => String(Object.values(r)[0]));
}

/** Of `orderIds`, those with a job not yet ready (Requested or At binder). */
export async function ordersWithOpenJobs(q: Queryable, orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const rows = await q
    .selectFrom('service_jobs as j')
    .innerJoin('sale_service_lines as sl', 'sl.id', 'j.service_line_id')
    .innerJoin('order_line_items as oli', 'oli.id', 'sl.order_line_item_id')
    .select('oli.order_id')
    .distinct()
    .where('oli.order_id', 'in', orderIds)
    .where('j.status', 'in', ['REQUESTED', 'AT_BINDER'])
    .execute();
  return new Set(rows.map((r) => String(r.order_id)));
}
