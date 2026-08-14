// ── Payment method metadata — single source of truth ────────────────────────
//
// Unifies the icon/label text that POS, Orders, Exchange settlement, and
// Payment Collection each used to define separately (and inconsistently —
// see the bug-fix comments this replaces in POSPage.tsx/PaymentsPage.tsx/
// ExchangesPage.tsx history). Every consumer renders the same label/icon for
// the same method code; the underlying value written to the API (and the
// business logic gating each method — bank account requirement, store
// credit/loyalty balance checks) stays exactly where it already lived, in
// each page's own submit handler. This file only owns presentation.
//
// 'mobile' (Telebirr) and 'card' are valid everywhere the backend accepts
// them (order_payments, financial_transactions, exchange_settlement_entries
// all had no restricting CHECK constraint, or already listed them;
// transaction_payments — POS — needed a migration to add 'mobile', see
// 1700000050_pos_payment_mobile.cjs). Each page still declares its own
// subset of methods to offer — this only standardizes how a given code is
// drawn, not which codes are valid in which context.

export type PaymentMethodCode = 'cash' | 'bank' | 'mobile' | 'card' | 'store_credit' | 'loyalty_points' | 'other';

export interface PaymentMethodMeta {
  code: PaymentMethodCode;
  label: string;
  icon: string;
}

export const PAYMENT_METHOD_META: Record<PaymentMethodCode, PaymentMethodMeta> = {
  cash:           { code: 'cash',           label: 'Cash',          icon: '💵' },
  bank:           { code: 'bank',           label: 'Bank Transfer', icon: '🏦' },
  mobile:         { code: 'mobile',         label: 'Telebirr',      icon: '📱' },
  card:           { code: 'card',           label: 'Card',          icon: '💳' },
  store_credit:   { code: 'store_credit',   label: 'Store Credit',  icon: '🎁' },
  loyalty_points: { code: 'loyalty_points', label: 'Loyalty',       icon: '⭐' },
  other:          { code: 'other',          label: 'Other',         icon: '•' },
};

/** Label with icon prefix, e.g. "📱 Telebirr" — for <select> options, table cells, etc. */
export function paymentMethodLabel(code: string): string {
  const meta = PAYMENT_METHOD_META[code as PaymentMethodCode];
  return meta ? `${meta.icon} ${meta.label}` : code.replace(/_/g, ' ');
}

/** Plain label with no icon, e.g. "Telebirr" — for compact inline contexts. */
export function paymentMethodPlainLabel(code: string): string {
  return PAYMENT_METHOD_META[code as PaymentMethodCode]?.label ?? code.replace(/_/g, ' ');
}
