import type { ServiceJobStep, ServiceLineInput } from '@bms/shared';
import type { Money } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { BusinessError, NotFoundError } from '../../lib/errors.js';
import { decryptPii } from '../../lib/piiEncryption.js';
import { insertOutboxEvent } from '../../lib/outbox.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as policy from './saleServices.policy.js';
import * as repo from './saleServices.repository.js';
import type {
  Actor, BindingOnLine, FeeReturn, JobBoardRecord, JobFilter, JobForCancel, PricedServiceLine, SaleRef, SaleServiceLineRecord, ServiceJobRecord,
} from './services.types.js';

/**
 * Services on a sale (#169 PR 2): pricing service lines, opening their jobs
 * and moving them on. Counter sales and orders call these inside their own
 * transaction, so a sale and its service lines and jobs are written, voided
 * or cancelled together; a job step is a use case of its own.
 */

function auditJob(q: Queryable, actor: Actor, action: string, jobId: number, meta: Record<string, unknown>) {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType: 'service_job',
    entityId: String(jobId),
    meta,
  });
}

/**
 * Prices the service on each book line that asks for one, at the branch's
 * fee; null where a line has none. A service needs a named customer: they are
 * called when the work is ready (decision 5 of #169).
 */
export async function priceServices(
  q: Queryable,
  items: Array<{ quantity: number; service?: ServiceLineInput }>,
  sale: { branchId: number; customerId: number | null; maxDiscountPct: number },
): Promise<Array<PricedServiceLine | null>> {
  if (items.some((i) => i.service) && sale.customerId === null) {
    throw new BusinessError('SERVICE_REQUIRES_CUSTOMER', 'A sale with a service needs a customer, who is called when the work is ready');
  }
  const priced: Array<PricedServiceLine | null> = [];
  for (const item of items) {
    if (!item.service) {
      priced.push(null);
      continue;
    }
    const service = await repo.findServiceForSale(q, item.service.serviceId, sale.branchId);
    if (!service) throw new NotFoundError(`Service ${item.service.serviceId}`);
    priced.push(policy.priceServiceLine(item.service, service, item.quantity, sale.maxDiscountPct));
  }
  return priced;
}

export { serviceTotals } from './saleServices.policy.js';

/** Records a book line's service line; returns its id. */
export function recordServiceLine(q: Queryable, bookLine: { posLineId: string } | { orderLineId: string }, line: PricedServiceLine): Promise<number> {
  return repo.insertServiceLine(q, bookLine, line);
}

/** Opens the job of a service line (4a), numbered from the shop's daily counter. */
export async function openJob(
  q: Queryable,
  actor: Actor,
  line: { id: number; turnaroundDays: number },
  sale: { branchId: number; customerId: number; number: string },
): Promise<number> {
  const jobNumber = await nextDailyNumber(q, 'SVC');
  const id = await repo.insertJob(q, {
    serviceLineId: line.id,
    branchId: sale.branchId,
    customerId: sale.customerId,
    jobNumber,
    turnaroundDays: line.turnaroundDays,
    staffId: actor.staffId,
  });
  await auditJob(q, actor, 'CREATE', id, { jobNumber, serviceLineId: line.id, sale: sale.number, status: 'REQUESTED' });
  return id;
}

/** An order's jobs open when it is confirmed, when it starts to count as a sale (5a). */
export async function openOrderJobs(q: Queryable, actor: Actor, order: { id: string; number: string; branchId: number; customerId: number | null }): Promise<void> {
  const lines = (await repo.linesOf(q, { orderId: order.id })).filter((l) => l.job === null);
  if (lines.length === 0) return;
  if (order.customerId === null) {
    throw new BusinessError('SERVICE_REQUIRES_CUSTOMER', 'An order with a service needs a customer, who is called when the work is ready');
  }
  for (const line of lines) {
    await openJob(q, actor, line, { branchId: order.branchId, customerId: order.customerId, number: order.number });
  }
}

/** The service lines of a sale, by the book line they belong to. */
export async function linesByBookLine(q: Queryable, sale: SaleRef): Promise<Map<string, SaleServiceLineRecord>> {
  const lines = await repo.linesOf(q, sale);
  return new Map(lines.map((l) => [(l.posLineId ?? l.orderLineId) as string, l]));
}

/**
 * A void or cancellation takes the sale's jobs with it, while their work has
 * not started (4a): they are Cancelled, audited. The jobs are locked first.
 */
export async function cancelJobs(q: Queryable, actor: Actor, sale: SaleRef, number: string): Promise<void> {
  const jobs = await repo.lockJobsOf(q, sale);
  policy.checkJobsCancellable(jobs.map((j) => j.status));
  for (const job of jobs.filter((j) => j.status === 'REQUESTED')) {
    await repo.setJobStatus(q, job.id, 'CANCELLED', actor.staffId);
    await auditJob(q, actor, 'UPDATE', job.id, { fromStatus: job.status, toStatus: 'CANCELLED', sale: number });
  }
}

/**
 * An order is delivered once its jobs are ready; the bound copies go with
 * it, so its ready jobs are Collected in the same step.
 */
export async function collectOnDelivery(q: Queryable, actor: Actor, order: { id: string; number: string }): Promise<void> {
  const jobs = await repo.lockJobsOf(q, { orderId: order.id });
  policy.checkJobsDeliverable(jobs.map((j) => j.status));
  for (const job of jobs.filter((j) => j.status === 'READY')) {
    await repo.setJobStatus(q, job.id, 'COLLECTED', actor.staffId);
    await auditJob(q, actor, 'UPDATE', job.id, { fromStatus: job.status, toStatus: 'COLLECTED', sale: order.number });
  }
}

/** Whether an order's jobs let it be delivered now (no job, or every one ready). */
export async function orderDeliverable(q: Queryable, orderId: string): Promise<boolean> {
  const lines = await repo.linesOf(q, { orderId });
  return policy.jobsDeliverable(lines.flatMap((l) => (l.job ? [l.job.status] : [])));
}

/** Of a page of orders, those whose jobs keep them from delivery. */
export function ordersWaitingOnJobs(q: Queryable, orderIds: string[]): Promise<Set<string>> {
  return repo.ordersWithOpenJobs(q, orderIds);
}

/** Moves a job of the session branch one step on (4a), audited. */
export async function stepJob(actor: Actor, id: number, step: ServiceJobStep): Promise<ServiceJobRecord> {
  return withTransaction({}, async (tx) => {
    const job = await repo.lockJob(tx, id, actor.branchId);
    if (!job) throw new NotFoundError('Service job');
    const status = policy.nextJobStatus(job.status, step);
    await repo.setJobStatus(tx, id, status, actor.staffId);
    await auditJob(tx, actor, 'UPDATE', id, { jobNumber: job.jobNumber, fromStatus: job.status, toStatus: status });
    if (status === 'READY') {
      // The selling roles of the branch are told, to call the customer (#169 PR 3, 2a). The
      // phone stays out of the notification: it is kept encrypted (#90); the board shows it.
      const notice = await repo.jobNotice(tx, id);
      await insertOutboxEvent(tx, 'service_job.ready', { jobId: id, jobNumber: job.jobNumber, branchId: job.branchId, ...notice });
    }
    return (await repo.lockJob(tx, id, actor.branchId)) as ServiceJobRecord;
  });
}

// ── After the sale (#169 PR 3) ───────────────────────────────────────────────

export { checkBoundReturn, checkCancellable, copiesLeft, feeShare } from './saleServices.policy.js';

/** The bindings of book lines a return names, by book line, their jobs locked. */
export function bindingsOf(q: Queryable, lines: { posLineIds: string[] } | { orderLineIds: string[] }): Promise<Map<string, BindingOnLine>> {
  return repo.bindingsOf(q, lines);
}

/** A job of the branch and the sale it belongs to, locked, for cancelling its binding. */
export async function jobForCancel(q: Queryable, jobId: number, branchId: number): Promise<JobForCancel> {
  const job = await repo.jobForCancel(q, jobId, branchId);
  if (!job) throw new NotFoundError('Service job');
  return job;
}

/**
 * Records a fee given back on a return, and what it does to the job: a
 * binding cancelled before its work is Cancelled (3a); once every bound copy
 * came back defective, the job is Returned (4a). Audited.
 */
export async function recordFeeReturn(q: Queryable, actor: Actor, returnId: string, fee: FeeReturn, saleNumber: string): Promise<void> {
  await repo.insertFeeReturn(q, returnId, fee);
  const job = fee.binding.jobId;
  if (job === null) return;
  const allBack = fee.binding.returnedQuantity + fee.quantity >= fee.binding.quantity;
  const status = fee.kind === 'CANCELLED' ? 'CANCELLED' : allBack ? 'RETURNED' : null;
  if (status !== null) await repo.setJobStatus(q, job, status, actor.staffId);
  await auditJob(q, actor, 'UPDATE', job, {
    jobNumber: fee.binding.jobNumber, fromStatus: fee.binding.jobStatus, toStatus: status ?? fee.binding.jobStatus,
    sale: saleNumber, returnId, feeReturned: fee.amount.toNumber(), copies: fee.quantity, kind: fee.kind,
  });
}

/** Fees given back on a counter sale so far. */
export function feesReturnedOnSale(q: Queryable, transactionId: string): Promise<Money> {
  return repo.feesReturnedOnSale(q, transactionId);
}

/** The jobs board (1a): the branch's jobs with the customer's phone, decrypted to be called. */
export async function listJobs(f: JobFilter, paging: { page: number; pageSize: number }): Promise<{ items: JobBoardRecord[]; total: number }> {
  const { rows, total } = await repo.listJobs(kysely, f, { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
  return {
    total,
    items: rows.map((r) => ({
      id: Number(r.id),
      jobNumber: r.job_number,
      // The database CHECK constraint limits status to these values.
      status: r.status as JobBoardRecord['status'],
      readyDate: r.ready_date,
      customerId: r.customer_id,
      branchId: r.branch_id,
      updatedAt: r.updated_at,
      overdue: r.overdue,
      serviceName: r.service_name,
      quantity: r.quantity,
      bookTitle: r.book_title,
      customerName: r.customer_name,
      customerPhone: decryptPii(r.phone_encrypted),
      source: r.transaction_id !== null ? 'POS' : 'ORDER',
      saleId: String(r.transaction_id ?? r.order_id),
      saleNumber: (r.transaction_number ?? r.order_number) as string,
    })),
  };
}

/** A job of the branch, as it stands now. */
export async function getJob(id: number, branchId: number): Promise<ServiceJobRecord> {
  const job = await repo.findJob(kysely, id, branchId);
  if (!job) throw new NotFoundError('Service job');
  return job;
}
