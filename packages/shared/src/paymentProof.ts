import { z } from 'zod';

/**
 * Proof of a Bank or Telebirr payment (owner decisions 1a, 2a, 3a,
 * 2026-10-18): a bank transfer names the bank the customer paid from and the
 * transfer's reference; a Telebirr payment its transaction number. Every flow
 * that takes customer money (POS sales and collections, order confirmation and
 * payments, exchanges, receivable collections) checks it with these rules, in
 * the API and in the forms.
 */

export const PAYER_BANK_MAX = 100;
export const PAYMENT_REFERENCE_MAX = 200;

/** The bank the customer paid from; bank payments only. */
export const PayerBankSchema = z.string().trim().max(PAYER_BANK_MAX, `At most ${PAYER_BANK_MAX} characters`);
/** A bank transfer's reference or a Telebirr transaction number. */
export const PaymentReferenceSchema = z.string().trim().max(PAYMENT_REFERENCE_MAX, `At most ${PAYMENT_REFERENCE_MAX} characters`);

export const PAYMENT_PROOF_MESSAGES = {
  payerBank: 'Enter the bank the customer paid from',
  bankReference: 'Enter the bank transfer reference',
  telebirrReference: 'Enter the Telebirr transaction number',
  payerBankNotBank: "Only a bank payment names the customer's bank",
} as const;

export interface PaymentProofIssue {
  field: 'payerBank' | 'reference';
  message: string;
}

/** What is missing from a payment's proof; empty when it is complete. */
export function paymentProofIssues(
  method: string | null | undefined,
  proof: { payerBank?: string | null; reference?: string | null },
): PaymentProofIssue[] {
  const bank = proof.payerBank?.trim() ?? '';
  const reference = proof.reference?.trim() ?? '';
  const issues: PaymentProofIssue[] = [];
  if (method === 'bank') {
    if (!bank) issues.push({ field: 'payerBank', message: PAYMENT_PROOF_MESSAGES.payerBank });
    if (!reference) issues.push({ field: 'reference', message: PAYMENT_PROOF_MESSAGES.bankReference });
  } else {
    if (bank) issues.push({ field: 'payerBank', message: PAYMENT_PROOF_MESSAGES.payerBankNotBank });
    if (method === 'mobile' && !reference) issues.push({ field: 'reference', message: PAYMENT_PROOF_MESSAGES.telebirrReference });
  }
  return issues;
}

/**
 * The proof rules as a zod refinement, reported on the schema's own field
 * names (`reference` on POS and exchange payments, `transactionReference` on
 * order payments). The bank is always `payerBank`.
 */
export function checkPaymentProof<T extends { payerBank?: string | null }>(fields: { method: keyof T; reference: keyof T }) {
  return (value: T, ctx: z.RefinementCtx): void => {
    const method = value[fields.method];
    const reference = value[fields.reference];
    for (const issue of paymentProofIssues(typeof method === 'string' ? method : null, {
      payerBank: value.payerBank,
      reference: typeof reference === 'string' ? reference : null,
    })) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: [issue.field === 'payerBank' ? 'payerBank' : String(fields.reference)] });
    }
  };
}
