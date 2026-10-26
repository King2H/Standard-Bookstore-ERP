import { Money, type ProfileResponse } from '@bms/shared';
import { isAmount } from '../pos/sale.js';
import { bindingTotal, type BindingChoice } from '../services/binding.js';

/**
 * Who may do what with exchanges, and the checks made before one is sent:
 * the API's rules (exchanges.routes.ts, exchanges.policy.ts), so the page
 * offers only what the API accepts. Any role held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Making an exchange: the selling roles. */
export const canExchange = (me: Account | undefined) => holds(me, ['Sales', 'Manager', 'Admin']);

/** Voiding an exchange on its day: Manager and Admin (was: by the main role only). */
export const canVoidExchange = (me: Account | undefined) => holds(me, ['Manager', 'Admin']);

/** Valuing a book that has no price yet: Manager and Admin. */
export const canValueUnpriced = (me: Account | undefined) => holds(me, ['Manager', 'Admin']);

/** A book the customer brings in, valued at `allowance` each (as typed). */
export interface IncomingLine {
  bookId: number;
  bookTitle: string;
  quantity: number;
  allowance: string;
  /** What the shop sells it for; null when it has no price yet. */
  sellingPrice: Money | null;
  condition: 'resellable' | 'damaged';
}

/** A book the customer takes, at its catalog price; a binding on some of its copies at the branch's fee (#169 PR 4). */
export interface OutgoingLine {
  bookId: number;
  bookTitle: string;
  quantity: number;
  unitPrice: Money;
  binding?: BindingChoice;
}

/** An allowance as typed, or zero while it is not a valid amount. */
export const allowanceOf = (raw: string) => (isAmount(raw) ? Money.of(raw.trim()) : Money.ZERO);

/** What comes in, what goes out, and the difference: above zero the customer owes it, below zero the store does. */
export function exchangeTotals(incoming: IncomingLine[], outgoing: OutgoingLine[]) {
  const incomingTotal = Money.sum(incoming.map((i) => allowanceOf(i.allowance).times(i.quantity)));
  const outgoingTotal = Money.sum(outgoing.map((o) => o.unitPrice.times(o.quantity).plus(o.binding ? bindingTotal(o.binding) : Money.ZERO)));
  return { incomingTotal, outgoingTotal, net: outgoingTotal.minus(incomingTotal) };
}

/**
 * Why a trade-in cannot be sent as valued, or null: each allowance is an
 * amount in whole cents (it becomes the book's cost), at most the book's
 * selling price, and a book with no price is valued only by a Manager or Admin.
 */
export function tradeInProblem(incoming: IncomingLine[], me: Account | undefined): string | null {
  for (const i of incoming) {
    if (!isAmount(i.allowance)) return `Enter a trade-in allowance for "${i.bookTitle}": more than zero, in whole cents`;
    if (i.sellingPrice === null) {
      if (!canValueUnpriced(me)) return `"${i.bookTitle}" has no price yet; a Manager or Admin values it`;
    } else if (allowanceOf(i.allowance).greaterThan(i.sellingPrice)) {
      return `"${i.bookTitle}" can be valued at most at its selling price, ${i.sellingPrice.toFixed()}`;
    }
  }
  return null;
}
