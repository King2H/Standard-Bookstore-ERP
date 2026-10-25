import { Money } from '@bms/shared';
import { bindingInput, bindingTotal, type BindingChoice } from '../services/binding.js';

/**
 * A new order's lines, pure: what each is worth after its discount, and what
 * stops the order before it is sent. Amounts are worked with Money; the API
 * prices the order again and has the last word.
 */

export type DiscountMode = 'Percentage' | 'Amount';

export interface OrderLine {
  bookId: number;
  bookTitle: string;
  quantity: number;
  unitPrice: Money;
  discountType: 'Normal' | 'Merchant' | 'Special';
  discountMode: DiscountMode;
  /** The discount as typed: a percentage or an amount, by its mode. */
  discount: string;
  /** Available at the order's location, when known. */
  availableStock: number | null;
  /** Binding on some or all of the line's copies (#169): its own line, under the book. */
  service?: BindingChoice;
}

const NUMBER = /^\d+(\.\d{1,2})?$/;

/** The discount as typed, or zero while it is empty or not a number. */
const typed = (l: OrderLine) => (NUMBER.test(l.discount.trim()) ? Money.of(l.discount.trim()) : Money.ZERO);

const lineBase = (l: OrderLine) => l.unitPrice.times(l.quantity).round(2);

/** What the line's discount takes off, never more than the line is worth. */
export function lineDiscount(l: OrderLine): Money {
  const base = lineBase(l);
  const wanted = l.discountMode === 'Percentage' ? base.percent(Money.min(100, typed(l)).toFixed(2)).round(2) : typed(l);
  return Money.min(base, wanted);
}

export const lineTotal = (l: OrderLine) => lineBase(l).minus(lineDiscount(l));

/** The order's total: its books after discount, and the fees of their bindings (#169). */
export const orderSubtotal = (lines: OrderLine[]) =>
  Money.sum([...lines.map(lineTotal), ...lines.flatMap((l) => (l.service ? [bindingTotal(l.service)] : []))]);

/**
 * Why the lines cannot be sent, or null: each discount is a number with at
 * most two decimals, a percentage at most 100, an amount at most what the
 * line is worth, and either within the most this person may give
 * (`max_line_discount_pct` by every role held; null while unknown).
 */
export function discountProblem(lines: OrderLine[], maxPct: number | null): string | null {
  for (const l of lines) {
    const raw = l.discount.trim();
    if (raw === '') continue;
    if (!NUMBER.test(raw)) return `Enter the discount on "${l.bookTitle}" as a number with at most two decimals`;
    const value = Money.of(raw);
    if (l.discountMode === 'Percentage' && value.greaterThan(100)) return `The discount on "${l.bookTitle}" can be at most 100%`;
    if (l.discountMode === 'Amount' && value.greaterThan(lineBase(l))) return `The discount on "${l.bookTitle}" is more than the line is worth`;
    if (maxPct !== null && lineDiscount(l).greaterThan(lineBase(l).percent(maxPct).round(2))) {
      return `The discount on "${l.bookTitle}" is more than your limit of ${maxPct}%`;
    }
  }
  return null;
}

/** A line as `POST /orders` takes it. */
export function lineInput(l: OrderLine) {
  const value = typed(l).toNumber();
  return {
    bookId: l.bookId,
    quantity: l.quantity,
    discountPct: l.discountMode === 'Percentage' ? value : undefined,
    discountAmount: l.discountMode === 'Amount' ? value : undefined,
    discountType: l.discountType,
    discountMode: l.discountMode,
    ...(l.service && { service: bindingInput(l.service) }),
  };
}
