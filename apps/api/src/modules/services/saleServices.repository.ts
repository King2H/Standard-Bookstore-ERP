import { sql } from 'kysely';
import { Money, type LifecycleStatus, type ServiceJobStatus } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import type {
  BindingOnLine, FeeReturn, JobFilter, JobForCancel, PricedServiceLine, SaleRef, SaleServiceLineRecord, ServiceForSale, ServiceJobRecord,
} from './services.types.js';

// The only SQL of services on a sale (#169 PR 2, A6). A service line belongs
// to one book line, of a counter sale, an order or the books an exchange gives
// out (PR 4); its job is the branch's.

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
  bookLine: { posLineId: string } | { orderLineId: string } | { exchangeLineId: string },
  line: PricedServiceLine,
): Promise<number> {
  const row = await q
    .insertInto('sale_service_lines')
    .values({
      transaction_line_item_id: 'posLineId' in bookLine ? bookLine.posLineId : null,
      order_line_item_id: 'orderLineId' in bookLine ? bookLine.orderLineId : null,
      exchange_outgoing_item_id: 'exchangeLineId' in bookLine ? bookLine.exchangeLineId : null,
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
      'sl.id', 'sl.transaction_line_item_id', 'sl.order_line_item_id', 'sl.exchange_outgoing_item_id', 'sl.service_id', 's.code', 's.name', 's.turnaround_days',
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
    exchangeLineId: r.exchange_outgoing_item_id === null ? null : String(r.exchange_outgoing_item_id),
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

/** The ids of a sale's service lines, as a subquery. */
function lineIdsOf(q: Queryable, sale: SaleRef) {
  if ('transactionId' in sale) {
    return q.selectFrom('sale_service_lines as sl').innerJoin('transaction_line_items as li', 'li.id', 'sl.transaction_line_item_id')
      .select('sl.id').where('li.transaction_id', '=', sale.transactionId);
  }
  if ('orderId' in sale) {
    return q.selectFrom('sale_service_lines as sl').innerJoin('order_line_items as oli', 'oli.id', 'sl.order_line_item_id')
      .select('sl.id').where('oli.order_id', '=', sale.orderId);
  }
  return q.selectFrom('sale_service_lines as sl').innerJoin('exchange_outgoing_items as eo', 'eo.id', 'sl.exchange_outgoing_item_id')
    .select('sl.id').where('eo.exchange_id', '=', sale.exchangeId);
}

/** The service lines of a counter sale, an order or an exchange, with their jobs. */
export async function linesOf(q: Queryable, sale: SaleRef): Promise<SaleServiceLineRecord[]> {
  const rows = await selectLines(q).where('sl.id', 'in', lineIdsOf(q, sale)).orderBy('sl.id').execute();
  return rows.map(toLineRecord);
}

/** The jobs of a sale's service lines, locked until the transaction ends. */
export async function lockJobsOf(q: Queryable, sale: SaleRef): Promise<Array<{ id: number; status: ServiceJobStatus }>> {
  const lineIds = lineIdsOf(q, sale);
  const rows = await q.selectFrom('service_jobs').select(['id', 'status']).where('service_line_id', 'in', lineIds).orderBy('id').forUpdate().execute();
  return rows.map((r) => ({ id: Number(r.id), status: r.status as ServiceJobStatus }));
}

/** A job of the branch, locked; another branch's is not found. */
export function lockJob(q: Queryable, id: number, branchId: number): Promise<ServiceJobRecord | undefined> {
  return findJob(q, id, branchId, { forUpdate: true });
}

/** A job of the branch; another branch's is not found. */
export async function findJob(q: Queryable, id: number, branchId: number, opts: { forUpdate?: boolean } = {}): Promise<ServiceJobRecord | undefined> {
  const row = await q
    .selectFrom('service_jobs')
    .select(['id', 'job_number', 'status', 'customer_id', 'branch_id', 'updated_at', sql<string>`TO_CHAR(ready_date, 'YYYY-MM-DD')`.as('ready_date')])
    .where('id', '=', String(id))
    .where('branch_id', '=', branchId)
    .$if(opts.forUpdate === true, (qb) => qb.forUpdate())
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

// ── After the sale (#169 PR 3) ───────────────────────────────────────────────

function selectBindings(q: Queryable) {
  return q
    .selectFrom('sale_service_lines as sl')
    .leftJoin('service_jobs as j', 'j.service_line_id', 'sl.id')
    .select([
      'sl.id', 'sl.transaction_line_item_id', 'sl.order_line_item_id', 'sl.quantity', 'sl.line_total', 'sl.standard_cost',
      'j.id as job_id', 'j.status as job_status', 'j.job_number',
      sql<number>`COALESCE((SELECT SUM(r.quantity) FROM return_service_lines r WHERE r.service_line_id = sl.id), 0)::int`.as('returned_quantity'),
      sql<string>`COALESCE((SELECT SUM(r.amount) FROM return_service_lines r WHERE r.service_line_id = sl.id), 0)`.as('returned_amount'),
    ]);
}

type BindingRow = Awaited<ReturnType<ReturnType<typeof selectBindings>['execute']>>[number];

function toBinding(r: BindingRow): BindingOnLine {
  return {
    serviceLineId: Number(r.id),
    quantity: r.quantity,
    lineTotal: Money.of(r.line_total),
    standardCost: Money.of(r.standard_cost),
    jobId: r.job_id === null ? null : Number(r.job_id),
    jobStatus: r.job_status as ServiceJobStatus | null,
    jobNumber: r.job_number,
    returnedQuantity: Number(r.returned_quantity),
    returnedAmount: Money.of(r.returned_amount),
  };
}

/** The bindings of book lines, by book line, their jobs locked until the transaction ends. */
export async function bindingsOf(q: Queryable, lines: { posLineIds: string[] } | { orderLineIds: string[] }): Promise<Map<string, BindingOnLine>> {
  const ids = 'posLineIds' in lines ? lines.posLineIds : lines.orderLineIds;
  if (ids.length === 0) return new Map();
  const byPos = 'posLineIds' in lines;
  await q
    .selectFrom('service_jobs')
    .select('id')
    .where('service_line_id', 'in', (eb) => eb.selectFrom('sale_service_lines').select('id')
      .where(byPos ? 'transaction_line_item_id' : 'order_line_item_id', 'in', ids))
    .forUpdate()
    .execute();
  const rows = await selectBindings(q).where(byPos ? 'sl.transaction_line_item_id' : 'sl.order_line_item_id', 'in', ids).execute();
  return new Map(rows.map((r) => [String(byPos ? r.transaction_line_item_id : r.order_line_item_id), toBinding(r)]));
}

/** A job of the branch with its binding and the sale it belongs to, locked; another branch's is not found. */
export async function jobForCancel(q: Queryable, jobId: number, branchId: number): Promise<JobForCancel | undefined> {
  const locked = await q.selectFrom('service_jobs').select('service_line_id').where('id', '=', String(jobId)).where('branch_id', '=', branchId).forUpdate().executeTakeFirst();
  if (!locked) return undefined;
  const row = await selectBindings(q)
    .leftJoin('transaction_line_items as li', 'li.id', 'sl.transaction_line_item_id')
    .leftJoin('order_line_items as oli', 'oli.id', 'sl.order_line_item_id')
    .leftJoin('exchange_outgoing_items as eo', 'eo.id', 'sl.exchange_outgoing_item_id')
    .select(['li.transaction_id', 'oli.order_id', 'eo.exchange_id'])
    .where('sl.id', '=', locked.service_line_id)
    .executeTakeFirstOrThrow();
  const sale: SaleRef = row.transaction_id !== null ? { transactionId: String(row.transaction_id) }
    : row.order_id !== null ? { orderId: String(row.order_id) } : { exchangeId: String(row.exchange_id) };
  return { binding: toBinding(row), sale };
}

export async function insertFeeReturn(q: Queryable, returnId: string, f: FeeReturn): Promise<void> {
  await q
    .insertInto('return_service_lines')
    .values({
      return_id: returnId,
      service_line_id: f.binding.serviceLineId,
      quantity: f.quantity,
      amount: f.amount.toFixed(2),
      cost_reversed: f.costReversed.toFixed(2),
      kind: f.kind,
    })
    .execute();
}

/** Fees given back on a counter sale so far, for the points its returns take back. */
export async function feesReturnedOnSale(q: Queryable, transactionId: string): Promise<Money> {
  const row = await q
    .selectFrom('return_service_lines as r')
    .innerJoin('sale_service_lines as sl', 'sl.id', 'r.service_line_id')
    .innerJoin('transaction_line_items as li', 'li.id', 'sl.transaction_line_item_id')
    .select(sql<string>`COALESCE(SUM(r.amount), 0)`.as('total'))
    .where('li.transaction_id', '=', transactionId)
    .executeTakeFirstOrThrow();
  return Money.of(row.total);
}

/** The jobs board (1a): the branch's jobs, the oldest ready date first. */
export async function listJobs(q: Queryable, f: JobFilter, page: { limit: number; offset: number }): Promise<{ rows: JobBoardRow[]; total: number }> {
  let query = q
    .selectFrom('service_jobs as j')
    .innerJoin('sale_service_lines as sl', 'sl.id', 'j.service_line_id')
    .innerJoin('services as s', 's.id', 'sl.service_id')
    .innerJoin('customers as c', 'c.id', 'j.customer_id')
    .leftJoin('transaction_line_items as li', 'li.id', 'sl.transaction_line_item_id')
    .leftJoin('transactions as t', 't.id', 'li.transaction_id')
    .leftJoin('order_line_items as oli', 'oli.id', 'sl.order_line_item_id')
    .leftJoin('orders as o', 'o.id', 'oli.order_id')
    .leftJoin('exchange_outgoing_items as eo', 'eo.id', 'sl.exchange_outgoing_item_id')
    .leftJoin('exchanges as e', 'e.id', 'eo.exchange_id')
    .innerJoin('books as b', (join) => join.on(sql`b.id`, '=', sql`COALESCE(li.book_id, oli.book_id, eo.book_id)`))
    .where('j.branch_id', '=', f.branchId);
  if (f.status) query = query.where('j.status', '=', f.status);
  if (f.overdue) query = query.where('j.status', 'in', ['REQUESTED', 'AT_BINDER']).where(sql<boolean>`j.ready_date < CURRENT_DATE`);
  if (f.q) {
    const pattern = `%${f.q.toLowerCase()}%`;
    query = query.where((eb) => eb.or([eb(sql`lower(j.job_number)`, 'like', pattern), eb(sql`lower(c.full_name)`, 'like', pattern)]));
  }
  const [rows, count] = await Promise.all([
    query
      .select([
        'j.id', 'j.job_number', 'j.status', 'j.customer_id', 'j.branch_id', 'j.updated_at',
        sql<string>`TO_CHAR(j.ready_date, 'YYYY-MM-DD')`.as('ready_date'),
        sql<boolean>`j.status IN ('REQUESTED', 'AT_BINDER') AND j.ready_date < CURRENT_DATE`.as('overdue'),
        's.name as service_name', 'sl.quantity', 'b.title as book_title', 'c.full_name as customer_name', 'c.phone_encrypted',
        't.id as transaction_id', 't.transaction_number', 'o.id as order_id', 'o.order_number',
        'e.id as exchange_id', 'e.exchange_reference',
      ])
      .orderBy('j.ready_date')
      .orderBy('j.id')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { rows, total: Number(count.count) };
}

export type JobBoardRow = {
  id: string | number | bigint; job_number: string; status: string; customer_id: number; branch_id: number; updated_at: Date;
  ready_date: string; overdue: boolean; service_name: string; quantity: number; book_title: string; customer_name: string;
  phone_encrypted: string | null; transaction_id: string | number | bigint | null; transaction_number: string | null;
  order_id: string | number | bigint | null; order_number: string | null;
  exchange_id: string | number | bigint | null; exchange_reference: string | null;
};

/** What the ready notice names: the customer to call and the binding. */
export async function jobNotice(q: Queryable, jobId: number): Promise<{ customerName: string; serviceName: string }> {
  const row = await q
    .selectFrom('service_jobs as j')
    .innerJoin('customers as c', 'c.id', 'j.customer_id')
    .innerJoin('sale_service_lines as sl', 'sl.id', 'j.service_line_id')
    .innerJoin('services as s', 's.id', 'sl.service_id')
    .select(['c.full_name', 's.name'])
    .where('j.id', '=', String(jobId))
    .executeTakeFirstOrThrow();
  return { customerName: row.full_name, serviceName: row.name };
}
