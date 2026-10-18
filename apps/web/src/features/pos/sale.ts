import { Money } from '@bms/shared';

/**
 * The counter's arithmetic, pure: line and cart totals, the amounts a cashier
 * types, what each tender needs, and the change on cash. Amounts are worked
 * with Money; the API prices the sale again and has the last word.
 */

export interface CartLine {
  bookId: number;
  bookTitle: string;
  bookIsbn: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  discountAmount: number;
  discountType: string;
  discountMode: string;
  lineTotal: number;
  isDivergent?: boolean;
}

/** A line's discount and total, the discount kept between nothing and the line's value. */
export function recalcLine(line: CartLine): CartLine {
  const base = Money.of(line.unitPrice).times(line.quantity).round(2);
  const wanted = line.discountMode === 'Percentage' ? base.percent(line.discountPct).round(2) : Money.of(line.discountAmount).round(2);
  const discount = Money.max(Money.ZERO, Money.min(base, wanted));
  return { ...line, discountAmount: discount.toNumber(), lineTotal: base.minus(discount).toNumber() };
}

export function cartTotals(lines: CartLine[]): { subtotal: Money; discountTotal: Money; grandTotal: Money } {
  const subtotal = Money.sum(lines.map((l) => Money.of(l.unitPrice).times(l.quantity).round(2)));
  const discountTotal = Money.sum(lines.map((l) => Money.of(l.discountAmount)));
  return { subtotal, discountTotal, grandTotal: Money.max(Money.ZERO, subtotal.minus(discountTotal)) };
}

/** A line's discount as a percentage of its value, as the API measures it. */
export function lineDiscountPct(line: CartLine): number {
  const base = Money.of(line.unitPrice).times(line.quantity).round(2);
  if (base.isZero()) return 0;
  return Number(Money.of(line.discountAmount).times(100).dividedBy(base.toFixed(2)).toFixed(2));
}

/** The first line whose discount is more than the cashier may give, or null. */
export function lineOverLimit(lines: CartLine[], maxPct: number): CartLine | null {
  return lines.find((l) => Money.of(l.discountAmount).greaterThan(Money.of(l.unitPrice).times(l.quantity).round(2).percent(maxPct).round(2))) ?? null;
}

/** An amount typed at the till: more than zero, in whole cents. */
export const AMOUNT_MESSAGE = 'Enter an amount more than zero, in whole cents';
export function isAmount(raw: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(raw.trim()) && Money.of(raw.trim()).greaterThan(0);
}

export interface PaymentLine {
  method: string;
  amount: string;
  bankAccountId?: number;
  payerBank?: string;
  reference?: string;
  /** Cash handed over, when more than was due; the change is the difference. */
  tendered?: string;
}

export const paidTotal = (lines: PaymentLine[]) => Money.sum(lines.map((p) => Money.of(p.amount)));

/**
 * What stops this tender before it is sent: store credit and loyalty points
 * come from the customer's account, so they need the customer and no more
 * than the account holds (points count one for one).
 */
export function tenderProblem(
  method: string,
  amount: Money,
  customer: { storeCreditBalance: number; loyaltyBalance: number } | null,
  lines: PaymentLine[],
): string | null {
  if (method !== 'store_credit' && method !== 'loyalty_points') return null;
  if (!customer) return method === 'store_credit' ? 'Select a customer to pay with store credit' : 'Select a customer to pay with loyalty points';
  const used = paidTotal(lines.filter((p) => p.method === method));
  const balance = Money.of(method === 'store_credit' ? customer.storeCreditBalance : customer.loyaltyBalance);
  if (used.plus(amount).greaterThan(balance)) {
    return method === 'store_credit'
      ? `Only ${balance.minus(used).toFixed(2)} of store credit is available`
      : `Only ${balance.minus(used).toFixed(0)} loyalty points are available`;
  }
  return null;
}

/**
 * Cash handed over for more than is due (owner decision 1a): the payment is
 * what was due and the rest goes back as change.
 */
export function cashLine(raw: string, due: Money): { amount: string; tendered?: string } {
  const handed = Money.of(raw.trim());
  if (due.greaterThan(0) && handed.greaterThan(due)) return { amount: due.toFixed(2), tendered: handed.toFixed(2) };
  return { amount: handed.toFixed(2) };
}

export const changeOf = (line: PaymentLine) => (line.tendered ? Money.of(line.tendered).minus(line.amount) : Money.ZERO);
