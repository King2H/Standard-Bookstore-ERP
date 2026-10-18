import { paymentProofIssues } from '@bms/shared';

/**
 * What a Bank or Telebirr payment carries (owner decisions 1a, 2a, 3a): the
 * bank the customer paid from and the transfer's reference, or the Telebirr
 * transaction number. Checked with the API's rules before sending.
 */
export interface PaymentProof {
  payerBank: string;
  reference: string;
}

export const EMPTY_PROOF: PaymentProof = { payerBank: '', reference: '' };

/** Whether a method asks for proof at all. */
export function needsProof(method: string): boolean {
  return method === 'bank' || method === 'mobile';
}

/** The first thing missing from the proof, or null when it is complete. */
export function proofError(method: string, proof: PaymentProof): string | null {
  return paymentProofIssues(method, proof)[0]?.message ?? null;
}

/** The proof as the API takes it: the bank for bank payments only, trimmed, nothing empty. */
export function proofFields(method: string, proof: PaymentProof): { payerBank?: string; reference?: string } {
  const payerBank = method === 'bank' ? proof.payerBank.trim() : '';
  const reference = proof.reference.trim();
  return { ...(payerBank && { payerBank }), ...(reference && { reference }) };
}

/** "Awash Bank · FT24001", "TB-77", or '' when nothing was recorded. */
export function proofLabel(payment: { payerBank?: string | null; reference?: string | null }): string {
  return [payment.payerBank, payment.reference].filter(Boolean).join(' · ');
}
