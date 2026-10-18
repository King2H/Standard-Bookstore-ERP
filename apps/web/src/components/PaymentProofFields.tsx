import { PAYER_BANK_MAX, PAYMENT_REFERENCE_MAX } from '@bms/shared';
import type { PaymentProof } from '../lib/paymentProof.js';

// Offered as the cashier types; any other bank can be typed in full.
const BANKS = [
  'Commercial Bank of Ethiopia',
  'Awash Bank',
  'Bank of Abyssinia',
  'Dashen Bank',
  'Wegagen Bank',
  'Hibret Bank',
  'Nib International Bank',
  'Cooperative Bank of Oromia',
  'Zemen Bank',
  'Bunna Bank',
  'Berhan Bank',
  'Abay Bank',
  'Enat Bank',
  'Oromia Bank',
  'Amhara Bank',
];

const INPUT =
  'w-full px-2.5 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500';

/**
 * The customer's bank and the transfer reference for a bank payment, the
 * transaction number for Telebirr (owner decisions 1a, 2a, 3a). Nothing for
 * other methods.
 */
export default function PaymentProofFields({ method, value, onChange, inputClassName = INPUT }: {
  method: string;
  value: PaymentProof;
  onChange: (proof: PaymentProof) => void;
  inputClassName?: string;
}) {
  if (method !== 'bank' && method !== 'mobile') return null;
  const referenceLabel = method === 'bank' ? 'Transfer reference' : 'Telebirr transaction number';
  return (
    <div className="space-y-1.5">
      {method === 'bank' && (
        <>
          <input
            aria-label="Customer's bank"
            list="payment-proof-banks"
            value={value.payerBank}
            maxLength={PAYER_BANK_MAX}
            onChange={(e) => onChange({ ...value, payerBank: e.target.value })}
            placeholder="Customer's bank"
            className={inputClassName}
          />
          <datalist id="payment-proof-banks">
            {BANKS.map((b) => <option key={b} value={b} />)}
          </datalist>
        </>
      )}
      <input
        aria-label={referenceLabel}
        value={value.reference}
        maxLength={PAYMENT_REFERENCE_MAX}
        onChange={(e) => onChange({ ...value, reference: e.target.value })}
        placeholder={referenceLabel}
        className={inputClassName}
      />
    </div>
  );
}
