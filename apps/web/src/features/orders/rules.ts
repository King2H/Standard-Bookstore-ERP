import type { ProfileResponse } from '@bms/shared';
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

/** Deleting an order: Admin (was: by the main role only). */
export const canDeleteOrder = (me: Account | undefined) => holds(me, ['Admin']);

/** A draft or cancelled order can be deleted while it has no history (the API checks that). */
export const isDeletable = (status: string) => ['DRAFT', 'Pending', 'CANCELLED', 'Cancelled'].includes(status);

/** The Dashboard's Pending Orders drill-down, and the filter's own option for it. */
export const PENDING_FULFILLMENT = 'Confirmed,In_Progress,CONFIRMED,PAID';

/**
 * The statuses an order can have now (was: also the names migration 33
 * retired, and PAID, which nothing sets; picking them always listed nothing).
 */
export const STATUS_FILTERS = ['DRAFT', 'CONFIRMED', 'COMPLETED', 'CANCELLED'] as const;

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
