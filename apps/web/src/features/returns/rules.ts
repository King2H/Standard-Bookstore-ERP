import { Money, type ProfileResponse } from '@bms/shared';
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

type SaleLine = { quantity: number; lineTotal: number };

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

/** How many units of a line can still come back; unknown returns (a counter sale's) leave it to the API. */
export const returnable = (line: { quantity: number; returned: number | null }) => line.quantity - (line.returned ?? 0);

type BoundLine = { quantity: number; returned: number | null; binding: { quantity: number; lineTotal: number; status: string | null } | null };

/**
 * How many copies of a line this return may take (#169 PR 3, decision 4a):
 * a bound copy comes back only defective, once collected; the others as any
 * book. What earlier returns took of each is the API's to check.
 */
export function returnableCopies(line: BoundLine, defective: boolean): number {
  if (!line.binding) return returnable(line);
  if (defective) return Math.min(returnable(line), line.binding.quantity);
  return Math.max(0, Math.min(returnable(line), line.quantity - line.binding.quantity));
}

/** A defective bound copy is taken back by a Manager or Admin, once the customer has it. */
export const defectiveReturnable = (line: BoundLine, me: Account | undefined) =>
  line.binding?.status === 'COLLECTED' && approverRole(me) !== undefined;

/** The share of the binding's fee that `quantity` defective copies give back, as the API values it. */
export function feeValue(line: BoundLine, quantity: number): Money {
  return line.binding ? lineValue({ quantity: line.binding.quantity, lineTotal: line.binding.lineTotal }, quantity) : Money.ZERO;
}
