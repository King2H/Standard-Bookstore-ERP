import { Money } from '@bms/shared';
import { BusinessError, ValidationError } from '../../lib/errors.js';
import type { ReceivableRecord, ReceivableStatus } from './receivables.types.js';

/**
 * Rules of receivables (A5), pure: what may be collected, written off or
 * rescheduled, and the status each of those leaves.
 */

/** Still owed: collected on, written off, rescheduled, counted as outstanding. */
export const OPEN_STATUSES: ReceivableStatus[] = ['Pending', 'PartiallyPaid', 'Overdue'];

export function isOpen(status: ReceivableStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

type Balance = Pick<ReceivableRecord, 'status' | 'originalAmount' | 'outstandingAmount'>;

/** Throws unless the receivable is still owed. */
export function checkOpen(r: Pick<ReceivableRecord, 'status'>): void {
  if (r.status === 'WrittenOff') {
    throw new BusinessError('RECEIVABLE_WRITTEN_OFF', 'This receivable was written off; it is closed');
  }
  if (r.status === 'Settled') {
    throw new BusinessError('RECEIVABLE_ALREADY_SETTLED', 'Receivable is already settled');
  }
}

export function checkCanCollect(r: Balance, amount: Money): void {
  checkOpen(r);
  if (!amount.greaterThan(0)) throw new ValidationError('Payment amount must be positive');
  if (amount.greaterThan(r.outstandingAmount)) {
    throw new BusinessError(
      'EXCEEDS_OUTSTANDING',
      `Payment of ETB ${amount.toFixed()} exceeds outstanding balance of ETB ${r.outstandingAmount.toFixed()}`,
      { outstanding: r.outstandingAmount.toNumber(), requested: amount.toNumber() },
    );
  }
}

function pastDue(dueDate: string | null, today: string): boolean {
  return dueDate !== null && dueDate < today;
}

/**
 * The status once `outstanding` is left to pay, on `today` (YYYY-MM-DD, the
 * database's calendar). A part payment does not make a past-due debt current.
 */
export function statusAfterPayment(
  r: Pick<ReceivableRecord, 'dueDate'>,
  outstanding: Money,
  fullySettled: boolean,
  today: string,
): ReceivableStatus {
  if (fullySettled || !outstanding.greaterThan(0)) return 'Settled';
  return pastDue(r.dueDate, today) ? 'Overdue' : 'PartiallyPaid';
}

/** The status of an open receivable once it is due on `dueDate` (or never). Due today is not yet overdue. */
export function statusForDueDate(r: Balance, dueDate: string | null, today: string): ReceivableStatus {
  if (pastDue(dueDate, today)) return 'Overdue';
  return r.outstandingAmount.lessThan(r.originalAmount) ? 'PartiallyPaid' : 'Pending';
}

/** What a write-off closes: everything still owed. */
export function checkCanWriteOff(r: Balance): Money {
  checkOpen(r);
  if (!r.outstandingAmount.greaterThan(0)) {
    throw new BusinessError('RECEIVABLE_ALREADY_SETTLED', 'Nothing is left to write off');
  }
  return r.outstandingAmount;
}
