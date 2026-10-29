import { PAY_IN_CATEGORIES, PAY_OUT_CATEGORIES, type CashMovementCategory, type CashMovementKind, type CashSessionStatus, type ProfileResponse } from '@bms/shared';

/** Names and rules of cash sessions (#171) on screen. */

export const STATUS_LABELS: Record<CashSessionStatus, string> = { open: 'Open', pending_review: 'Waiting for review', closed: 'Closed' };

export const KIND_LABELS: Record<CashMovementKind, string> = {
  pos_payment: 'POS sale', pos_void: 'POS void', order_payment: 'Order payment', order_refund: 'Order refund',
  receivable_payment: 'Collection', return_refund: 'Return refund', exchange_payment: 'Exchange payment',
  exchange_refund: 'Exchange refund', exchange_void: 'Exchange void', pay_in: 'Cash in', pay_out: 'Cash out',
};

export const CATEGORY_LABELS: Record<CashMovementCategory, string> = {
  float_top_up: 'Float top-up', bank_drop: 'Bank drop', petty_cash: 'Petty cash', other: 'Other',
};

export const METHOD_LABELS: Record<string, string> = { cash: 'Cash', bank: 'Bank', mobile: 'Telebirr' };

/** The types that fit cash put in or taken out. */
export const categoriesFor = (direction: 'in' | 'out'): readonly CashMovementCategory[] => (direction === 'in' ? PAY_IN_CATEGORIES : PAY_OUT_CATEGORIES);

const holds = (me: ProfileResponse | undefined, roles: string[]) => (me?.currentRoles ?? []).some((r) => roles.includes(r));

/** Accepting a count beyond the limit and closing another's session: Admin and Manager (REVIEW_CASH_SESSION). */
export const canReviewCash = (me: ProfileResponse | undefined) => holds(me, ['Admin', 'Manager']);

/** Over when positive, short when negative. */
export function varianceLabel(variance: number, format: (n: number) => string): string {
  if (variance === 0) return 'Even';
  return `${variance > 0 ? 'Over' : 'Short'} ${format(Math.abs(variance))}`;
}

/** A cash amount as the API takes it: not negative, at most two decimals. */
export const isCashAmount = (v: string) => /^\d+(\.\d{1,2})?$/.test(v);
