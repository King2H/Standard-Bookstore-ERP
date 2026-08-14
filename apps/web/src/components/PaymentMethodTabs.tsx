// ── PaymentMethodTabs — shared payment-method picker ────────────────────────
//
// The one method-picker UI for every payment "form" with room for it (POS,
// Payment Collection, Exchange settlement) — same button styling, same
// icon/label per method everywhere it appears. Purely presentational: the
// caller owns the selected value, the onChange handler, which methods are
// offered, and everything that happens after a method is picked (bank
// account requirement, store credit/loyalty balance display, validation).
// Not used by OrdersPage's inline row-action confirm — that's a compact
// table-row control, not a dedicated form, so a multi-button grid doesn't
// fit there; it instead sources its <select> options' text from the same
// paymentMethods.ts metadata this component reads, for label consistency
// without forcing a layout that doesn't belong in that context.

import { PAYMENT_METHOD_META, type PaymentMethodCode } from '../lib/paymentMethods.js';

const COLUMN_CLASSES: Record<number, string> = {
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  5: 'grid-cols-5',
};

export default function PaymentMethodTabs({ methods, value, onChange, columns = 4 }: {
  methods: PaymentMethodCode[];
  value: string;
  onChange: (method: PaymentMethodCode) => void;
  /** Grid columns — pick whatever fits the available methods/space; defaults to 4. */
  columns?: 3 | 4 | 5;
}) {
  return (
    <div className={`grid ${COLUMN_CLASSES[columns] ?? 'grid-cols-4'} gap-1.5`}>
      {methods.map(code => {
        const meta = PAYMENT_METHOD_META[code];
        const active = value === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => onChange(code)}
            className={`flex flex-col items-center gap-0.5 py-1.5 px-1 rounded-lg text-xs font-semibold transition-all ${
              active
                ? 'bg-blue-600 text-white shadow-sm shadow-blue-600/30'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            <span className="text-sm leading-none">{meta.icon}</span>
            <span className="leading-tight">{meta.label}</span>
          </button>
        );
      })}
    </div>
  );
}
