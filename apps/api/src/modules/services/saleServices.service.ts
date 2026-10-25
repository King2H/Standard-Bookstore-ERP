import type { ServiceJobStep, ServiceLineInput } from '@bms/shared';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { nextDailyNumber } from '../../lib/documentNumber.js';
import { BusinessError, NotFoundError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as policy from './saleServices.policy.js';
import * as repo from './saleServices.repository.js';
import type { Actor, PricedServiceLine, SaleRef, SaleServiceLineRecord, ServiceJobRecord } from './services.types.js';

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

/** A bound copy comes back through Returns only with PR 3's rules (decision 6 of #169); until then it is refused. */
export async function checkNotBound(q: Queryable, lines: { posLineIds: string[] } | { orderLineIds: string[] }): Promise<void> {
  const bound = await repo.boundLines(q, lines);
  if (bound.length > 0) {
    throw new BusinessError('BOUND_COPY_RETURN', 'A copy sold with a binding service cannot be returned yet', { lineIds: bound });
  }
}

/** Moves a job of the session branch one step on (4a), audited. */
export async function stepJob(actor: Actor, id: number, step: ServiceJobStep): Promise<ServiceJobRecord> {
  return withTransaction({}, async (tx) => {
    const job = await repo.lockJob(tx, id, actor.branchId);
    if (!job) throw new NotFoundError('Service job');
    const status = policy.nextJobStatus(job.status, step);
    await repo.setJobStatus(tx, id, status, actor.staffId);
    await auditJob(tx, actor, 'UPDATE', id, { jobNumber: job.jobNumber, fromStatus: job.status, toStatus: status });
    return (await repo.lockJob(tx, id, actor.branchId)) as ServiceJobRecord;
  });
}
