import {
  CollectReceivableRequestSchema, Money, OrderPaymentMethodSchema, PosPaymentMethodSchema,
  type Payment, type PaymentsLedgerRow, type ProfileResponse, type UnpaidItem,
} from '@bms/shared';
import { proofError, type PaymentProof } from '../../lib/paymentProof.js';
import type { PaymentMethodCode } from '../../lib/paymentMethods.js';
import { AMOUNT_MESSAGE, isAmount } from '../pos/sale.js';
import type { UnpaidSource } from './api.js';

/**
 * Who may do what with payments, and what a collection or refund needs: the
 * API's rules (payments.routes.ts, payments.policy.ts), so the page offers
 * only what the API accepts. Any role held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Taking a payment: the roles that see payments (PROCESS_PAYMENT). */
export const canTakePayment = (me: Account | undefined) => holds(me, ['Sales', 'Manager', 'Admin', 'Finance_Officer']);

/** Money In & Out reads the Payments ledger, a report: VIEW_REPORTS (Super_Admin has no Payments page). */
export const canSeeMoneyInOut = (me: Account | undefined) => holds(me, ['Manager', 'Admin', 'Finance_Officer']);

/**
 * Customer money of the ledger: what came in, what went back and what is left,
 * as the Dashboard's Cash Collected counts it. Supplier payments (PO) are the
 * shop's own spending, not customer money.
 */
export function customerMoney(rows: PaymentsLedgerRow[]) {
  const customer = rows.filter((r) => r.referenceType !== 'PO');
  const sum = (direction: 'IN' | 'OUT') => Money.sum(customer.filter((r) => r.direction === direction).map((r) => r.amount));
  const moneyIn = sum('IN');
  const moneyOut = sum('OUT');
  return { rows: customer, moneyIn, moneyOut, net: moneyIn.minus(moneyOut) };
}

/** Refunding a payment: PROCESS_REFUND. */
export const canRefundPayment = (me: Account | undefined) => holds(me, ['Manager', 'Admin', 'Finance_Officer']);

/** An unpaid order, POS sale and receivable can share an id: it is unique only with its source. */
export const rowKey = (row: { id: string; sourceType?: string }) => `${row.sourceType ?? 'order'}:${row.id}`;

/**
 * The methods each collection endpoint takes (owner decision 2a; was: card
 * offered on a POS sale and loyalty points on an exchange difference, both
 * refused). 'other' is not offered at the counter.
 */
export const COLLECT_METHODS: Record<UnpaidSource, PaymentMethodCode[]> = {
  order: OrderPaymentMethodSchema.options.filter((m) => m !== 'other'),
  pos: [...PosPaymentMethodSchema.options],
  exchange_difference: [...CollectReceivableRequestSchema.shape.paymentMethod.options],
};

/** The statuses a payment can have (was: also pending and failed, which nothing writes). */
export const HISTORY_STATUSES = ['success', 'refunded', 'partially_refunded'] as const;

/**
 * Only an order payment is refunded here: a POS sale's goes back through a
 * return, an exchange's through the exchange. A fulfilled order's books were
 * handed over, so its money comes back through a return too.
 */
export function isRefundable(p: Pick<Payment, 'sourceType' | 'status' | 'orderStatus'>): boolean {
  if ((p.sourceType ?? 'order') !== 'order') return false;
  if (p.status === 'failed' || p.status === 'refunded') return false;
  return !['FULFILLED', 'COMPLETED'].includes((p.orderStatus ?? '').toUpperCase());
}

/** What is left of a payment to refund: its amount less earlier refunds. */
export function refundable(p: Pick<Payment, 'amount' | 'refunds'>): Money {
  return Money.max(0, Money.of(p.amount).minus(Money.sum((p.refunds ?? []).map((r) => Money.of(r.refundAmount)))));
}

/** An amount typed for a payment or refund: whole cents, more than zero, at most `limit`. */
export function amountProblem(raw: string, limit: Money, over: string): string | null {
  if (!isAmount(raw)) return AMOUNT_MESSAGE;
  return Money.of(raw.trim()).greaterThan(limit) ? over : null;
}

export interface Collection {
  method: string;
  amount: string;
  outstanding: Money;
  proof: PaymentProof;
  bankAccountId: number | null;
  bankAccountRequired: boolean;
  /** Who owes it, and their balances once loaded; null when nobody is named. */
  customer: { storeCreditBalance: number; loyaltyBalance: number } | 'loading' | null;
}

/** What stops this collection before it is sent, or null. */
export function collectionProblem(c: Collection): string | null {
  const amount = amountProblem(c.amount, c.outstanding, `Enter no more than the ${c.outstanding.toFixed(2)} outstanding`);
  if (amount) return amount;
  if (c.method === 'bank' && c.bankAccountRequired && !c.bankAccountId) return 'Select a bank account for bank transfer payments';
  if (c.method === 'store_credit' || c.method === 'loyalty_points') {
    if (c.customer === null) return c.method === 'store_credit' ? 'Store credit needs a customer on the sale' : 'Loyalty points need a customer on the sale';
    if (c.customer === 'loading') return 'The customer\'s balance is still loading';
    const value = Money.of(c.amount.trim());
    // Points count one for one.
    const balance = Money.of(c.method === 'store_credit' ? c.customer.storeCreditBalance : c.customer.loyaltyBalance);
    if (value.greaterThan(balance)) {
      return c.method === 'store_credit'
        ? `Only ${balance.toFixed(2)} of store credit is available`
        : `Only ${balance.toFixed(0)} loyalty points are available`;
    }
  }
  return proofError(c.method, c.proof);
}

/** What the customer still owes on this row: the order's own balance when loaded. */
export const outstandingOf = (row: Pick<UnpaidItem, 'outstanding'>, balance?: { outstanding: number }) =>
  Money.of(balance?.outstanding ?? row.outstanding);
