import { Money, type ServiceJobStatus, type ServiceJobStep, type ServiceLineInput } from '@bms/shared';
import { BusinessError } from '../../lib/errors.js';
import type { PricedServiceLine, ServiceForSale } from './services.types.js';

/**
 * Rules of services on a sale (#169 PR 2, A5), pure: pricing a service line
 * and moving its job.
 */

/**
 * A service line for `bookQuantity` copies of a book line: some or all of
 * them (2a), at the branch's fee. A discount is taken only when the service
 * allows it, and never above the cashier's line limit, as for books (3a).
 */
export function priceServiceLine(input: ServiceLineInput, service: ServiceForSale, bookQuantity: number, maxDiscountPct: number): PricedServiceLine {
  if (service.status !== 'ACTIVE') {
    throw new BusinessError('SERVICE_INACTIVE', `Service ${service.code} is not active`);
  }
  if (input.quantity > bookQuantity) {
    throw new BusinessError('SERVICE_QUANTITY_EXCEEDS_BOOKS', `${service.code} is for ${input.quantity} copies; the line has ${bookQuantity}`, {
      serviceQuantity: input.quantity,
      bookQuantity,
    });
  }
  const base = service.fee.times(input.quantity).round(2);
  const discountAmount = input.discountMode === 'Amount'
    ? Money.min(Money.of(input.discountAmount ?? 0), base).round(2)
    : base.percent(input.discountPct ?? 0).round(2);
  if (discountAmount.greaterThan(0) && !service.discountable) {
    throw new BusinessError('FEE_NOT_DISCOUNTABLE', `The fee for ${service.code} may not be discounted`);
  }
  if (discountAmount.greaterThan(base.percent(maxDiscountPct).round(2))) {
    const requested = base.isZero() ? 0 : Number(discountAmount.times(100).dividedBy(base.toFixed(2)).toFixed(2));
    throw new BusinessError('DISCOUNT_EXCEEDS_LIMIT', `Discount ${requested}% exceeds maximum allowed ${maxDiscountPct}%`, {
      maxDiscPct: maxDiscountPct,
      requested,
    });
  }
  const discountPct = base.isZero() ? 0 : Number(discountAmount.times(100).dividedBy(base.toFixed(2)).toFixed(4));
  return {
    serviceId: service.id,
    quantity: input.quantity,
    unitFee: service.fee,
    discountPct,
    discountAmount,
    lineTotal: base.minus(discountAmount),
    standardCost: service.standardCost,
    turnaroundDays: service.turnaroundDays,
  };
}

/** What the service lines add to a sale's totals. */
export function serviceTotals(lines: Array<PricedServiceLine | null>): { subtotal: Money; discountTotal: Money } {
  const priced = lines.filter((l): l is PricedServiceLine => l !== null);
  return { subtotal: Money.sum(priced.map((l) => l.lineTotal)), discountTotal: Money.sum(priced.map((l) => l.discountAmount)) };
}

const NEXT: Record<ServiceJobStep, { from: ServiceJobStatus; to: ServiceJobStatus }> = {
  send: { from: 'REQUESTED', to: 'AT_BINDER' },
  ready: { from: 'AT_BINDER', to: 'READY' },
  collect: { from: 'READY', to: 'COLLECTED' },
};

/** A job moves one step at a time: Requested -> At binder -> Ready -> Collected (4a). */
export function nextJobStatus(current: ServiceJobStatus, step: ServiceJobStep): ServiceJobStatus {
  const { from, to } = NEXT[step];
  if (current !== from) {
    throw new BusinessError('INVALID_JOB_STEP', `A job that is ${current} cannot be moved to ${to}`, { status: current, step });
  }
  return to;
}

/**
 * A void or cancellation gives the fee back only while the work has not
 * started (decision 6 of #169); until PR 3 adds the rules for later, it is
 * refused once a job left Requested.
 */
export function checkJobsCancellable(statuses: ServiceJobStatus[]): void {
  if (statuses.some((s) => s !== 'REQUESTED' && s !== 'CANCELLED')) {
    throw new BusinessError('SERVICE_JOB_IN_PROGRESS', 'A binding job on this sale has started; it can no longer be voided or cancelled');
  }
}

/** An order is delivered with its bound copies, so every job must be ready (or already handed over). */
export function checkJobsDeliverable(statuses: ServiceJobStatus[]): void {
  if (statuses.some((s) => s === 'REQUESTED' || s === 'AT_BINDER')) {
    throw new BusinessError('SERVICE_JOBS_OPEN', 'The order has binding jobs that are not ready; it is delivered once they are');
  }
}

/** Whether an order's jobs let it be delivered now. */
export function jobsDeliverable(statuses: ServiceJobStatus[]): boolean {
  return !statuses.some((s) => s === 'REQUESTED' || s === 'AT_BINDER');
}
