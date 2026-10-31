import { Money, type OrderLineItem, type ProfileResponse } from '@bms/shared';
import { proofError, proofFields, type PaymentProof } from '../../lib/paymentProof.js';
import type { ConfirmOrder } from './api.js';

/**
 * Who may do what with orders: the API's rules (orders.routes.ts,
 * orders.policy.ts), so the page offers only what the API accepts. Any role
 * held in the session branch counts. The steps an order is open to come
 * from the API with it (allowedActions).
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Taking a new order: the selling roles (CREATE_SALE). */
export const canCreateOrder = (me: Account | undefined) => holds(me, ['Sales', 'Manager', 'Admin']);

/** Deleting an order: Admin (was: by the main role only). */
export const canDeleteOrder = (me: Account | undefined) => holds(me, ['Admin']);

/** A draft or cancelled order can be deleted while it has no history (the API checks that). */
export const isDeletable = (status: string) => ['DRAFT', 'Pending', 'CANCELLED', 'Cancelled'].includes(status);

/** The Dashboard's Pending Orders drill-down, and the filter's own option for it; part-delivered ones still wait (#174). */
export const PENDING_FULFILLMENT = 'Confirmed,In_Progress,CONFIRMED,PAID,PART_DELIVERED';

/**
 * The statuses an order can have now (was: also the names migration 33
 * retired, and PAID, which nothing sets; picking them always listed nothing).
 */
export const STATUS_FILTERS = ['DRAFT', 'CONFIRMED', 'PART_DELIVERED', 'COMPLETED', 'CANCELLED'] as const;

/** How a status reads on screen. */
export const statusLabel = (status: string) => (status === 'PART_DELIVERED' ? 'Part delivered' : status);

type WaitingLine = Pick<OrderLineItem, 'id' | 'bookTitle' | 'qtyReserved'>;

/** What is wrong with the copies entered for a delivery, or null (#174): whole copies, at most what is waiting, some at all. */
export function deliveryProblem(lines: WaitingLine[], entered: Record<string, string>): string | null {
  for (const l of lines) {
    const v = (entered[l.id] ?? '').trim();
    if (v !== '' && !/^\d+$/.test(v)) return `${l.bookTitle}: enter whole copies`;
    if (Number(v) > l.qtyReserved) return `${l.bookTitle}: at most ${l.qtyReserved} can be delivered`;
  }
  return lines.some((l) => Number(entered[l.id] ?? 0) > 0) ? null : 'Enter at least one copy to deliver';
}

/** What `quantity` copies of a line are worth: their share of what the line cost (as the API values them). */
export const shareOf = (line: Pick<OrderLineItem, 'quantity' | 'totalPrice'>, quantity: number) =>
  quantity === line.quantity ? Money.of(line.totalPrice) : Money.of(line.totalPrice).times(quantity).dividedBy(line.quantity).round(2);

/** What a cash order's payment still lacks before it can be confirmed, or null. */
export function cashPaymentProblem(method: string, proof: PaymentProof, bankAccountId: number | null, bankAccountRequired: boolean): string | null {
  if (method === 'bank' && bankAccountRequired && !bankAccountId) return 'Select a bank account for bank transfer payments';
  return proofError(method, proof);
}

/** The confirm body of a cash order: its method and, for bank and Telebirr, the proof. */
export function cashConfirmBody(method: string, proof: PaymentProof, bankAccountId: number | null): ConfirmOrder {
  const { payerBank, reference } = proofFields(method, proof);
  return {
    paymentMethod: method,
    ...(payerBank && { payerBank }),
    ...(reference && { transactionReference: reference }),
    ...(method === 'bank' && bankAccountId ? { bankAccountId } : {}),
  };
}
