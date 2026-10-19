import { Money, type PosTransaction, type ProfileResponse } from '@bms/shared';
import { paymentMethodPlainLabel } from '../../lib/paymentMethods.js';

/**
 * Who may do what with returns: the API's rules (returns.routes.ts,
 * returns.policy.ts), so the page offers only what the API accepts. Any role
 * held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Processing a return: Sales, Manager and Admin (was: offered to a Finance_Officer, whom the API refuses). */
export const canProcessReturn = (me: Account | undefined) => holds(me, ['Sales', 'Manager', 'Admin']);

/** The role that lets this account process a return above the approval limit, if any. */
export const approverRole = (me: Account | undefined): string | undefined =>
  (me?.currentRoles ?? []).find((r) => r === 'Admin' || r === 'Manager');

type SaleLine = NonNullable<PosTransaction['lineItems']>[number];

/** What `quantity` units of a line are worth: their share of what the line cost after its discount, as the API values them. */
export function lineValue(line: SaleLine, quantity: number): Money {
  if (line.quantity <= 0 || quantity <= 0) return Money.ZERO;
  return Money.of(line.lineTotal).times(quantity).dividedBy(line.quantity).round(2);
}

/** How a refund went back: a payment method, a credit note against what the sale owed, or mixed. */
export function refundLabel(method: string): string {
  if (method === 'credit_note') return 'Credit Note';
  if (method === 'mixed') return 'Mixed';
  return paymentMethodPlainLabel(method);
}
