import { Fragment, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Money, type BookAvailabilityListResponse, type Customer, type PosTransaction } from '@bms/shared';
import { getCurrentBranchId } from '../../../lib/api.js';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import QuickAddCustomer, { type QuickCustomerPayload } from '../../../components/QuickAddCustomer.js';
import PaymentMethodTabs from '../../../components/PaymentMethodTabs.js';
import BankAccountSelect from '../../../components/BankAccountSelect.js';
import PaymentProofFields from '../../../components/PaymentProofFields.js';
import { EMPTY_PROOF, proofError, proofFields, proofLabel, type PaymentProof } from '../../../lib/paymentProof.js';
import { paymentMethodPlainLabel, PAYMENT_METHOD_META, type PaymentMethodCode } from '../../../lib/paymentMethods.js';
import { useMyProfile } from '../../account/queries.js';
import { useBranchBankAccounts } from '../../bankAccounts/queries.js';
import { createCustomer } from '../../customers/api.js';
import { useLocations } from '../../locations/queries.js';
import { getEffectiveConfig } from '../../settings/api.js';
import { useEffectiveSetting } from '../../settings/queries.js';
import { useBooksForSale, useCreateSale, useCustomersForSale } from '../queries.js';
import { maxDiscountPct } from '../rules.js';
import {
  AMOUNT_MESSAGE, cartTotals, cashLine, changeOf, isAmount, lineOverLimit, paidTotal, recalcLine, tenderProblem,
  type CartLine, type PaymentLine,
} from '../sale.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type Role = string;

type BookWithAvailability = BookAvailabilityListResponse['items'][number];

type DiscountPresetType = 'Normal' | 'Merchant' | 'Special';
const DISCOUNT_PRESET_TYPES = ['Normal', 'Merchant', 'Special'] as const;

function isDiscountPresetType(value: string): value is DiscountPresetType {
  return DISCOUNT_PRESET_TYPES.includes(value as DiscountPresetType);
}

const DEFAULT_DISCOUNT_PRESETS: Record<DiscountPresetType, DiscountPreset> = {
  Normal:   { mode: 'Percentage', value: 0, source: 'unset' },
  Merchant: { mode: 'Percentage', value: 0, source: 'unset' },
  Special:  { mode: 'Percentage', value: 0, source: 'unset' },
};

interface DiscountPreset {
  mode: 'Percentage' | 'Amount';
  value: number;
  source: 'branch' | 'system' | 'unset';
}

const DISCOUNT_KEYS = [
  'default_discount_type',
  'default_discount_mode_normal', 'default_discount_value_normal',
  'default_discount_mode_merchant', 'default_discount_value_merchant',
  'default_discount_mode_special', 'default_discount_value_special',
  'max_line_discount_pct',
];

/** A receipt: the sale as the API recorded it, and the change given on cash. */
type Receipt = PosTransaction & { change: Money };

/** The day itself, wherever the till is (a YYYY-MM-DD read as UTC midnight shows the day before west of UTC). */
const localDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString();

/** Only the receipt is printed (owner decision 2a), at a receipt printer's width. */
const RECEIPT_PRINT_CSS = `@media print {
  body * { visibility: hidden; }
  #pos-receipt, #pos-receipt * { visibility: visible; }
  #pos-receipt { position: absolute; left: 0; top: 0; width: 80mm; box-shadow: none; border: 0; }
  #pos-receipt .no-print { display: none; }
}`;

/**
 * The POS terminal (#23, POS part 2): the cart, the customer, payments and
 * the receipt. The page (pages/PosPage.tsx) owns the tabs; the terminal stays
 * mounted under them so the cart survives a look at Sales History.
 */
interface PosTerminalProps {
  userRole?: Role; userPermissions?: string[];
  tabBar: ReactNode;
  view: 'pos' | 'history';
  history: ReactNode;
}

// ── Permissions ───────────────────────────────────────────────────────────────

const canCreate = (r?: Role, perms?: string[]) =>
  (perms?.includes('CREATE_SALE')) || ['Sales', 'Manager', 'Admin', 'Super_Admin'].includes(r ?? '');

// ── Payment ───────────────────────────────────────────────────────────────────

type PaymentMethod = PaymentMethodCode;
const PAYMENT_TABS: PaymentMethod[] = ['cash', 'bank', 'mobile', 'store_credit', 'loyalty_points'];

// ─────────────────────────────────────────────────────────────────────────────
//  Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function Terminal({ userRole, userPermissions, tabBar, view, history }: PosTerminalProps) {
  const { showToast } = useToast();
  const currency    = useCurrency();
  const { data: me } = useMyProfile();

  // ── POS state ──────────────────────────────────────────────────────────────
  const [bookSearch, setBookSearch]               = useState('');
  const [cart, setCart]                           = useState<CartLine[]>([]);
  const [selectedCustomer, setSelectedCustomer]   = useState<Customer | null>(null);
  const [dueDate, setDueDate]                     = useState<string>('');
  const [customerSearch, setCustomerSearch]       = useState('');
  const [showQuickAdd, setShowQuickAdd]           = useState(false);
  const [locationId, setLocationId]               = useState<number | null>(null);
  const [paymentLines, setPaymentLines]           = useState<PaymentLine[]>([]);
  const [payMethod, setPayMethod]                 = useState<PaymentMethod>('cash');
  const [payAmount, setPayAmount]                 = useState('');
  const [payBankAccountId, setPayBankAccountId]   = useState<number | ''>('');
  const [payProof, setPayProof]                   = useState<PaymentProof>(EMPTY_PROOF);
  const [receipt, setReceipt]                     = useState<Receipt | null>(null);

  // Discount state
  const [defaultDiscountType, setDefaultDiscountType]     = useState<DiscountPresetType>('Normal');
  const [discountPresets, setDiscountPresets]             = useState<Record<DiscountPresetType, DiscountPreset>>(DEFAULT_DISCOUNT_PRESETS);
  const activeDiscountPreset = discountPresets[defaultDiscountType] ?? discountPresets.Normal;

  // Keyboard refs
  const bookSearchRef     = useRef<HTMLInputElement>(null);
  const customerSearchRef = useRef<HTMLInputElement>(null);
  const payAmountRef      = useRef<HTMLInputElement>(null);

  const branchId = getCurrentBranchId();

  // ── Queries ────────────────────────────────────────────────────────────────

  // Staff limited to some locations get only those (#72).
  const { data: locData } = useLocations(branchId);

  // With Bank Accounts on, a bank payment names the account it went to (#21).
  const { accounts: bankAccounts, required: bankAccountRequired } = useBranchBankAccounts(branchId, payMethod === 'bank');

  // A book with no stock can still be sold where the branch allows negative stock.
  const allowNegative = useEffectiveSetting('allow_negative_stock') === true;

  const { data: bookResults } = useBooksForSale(bookSearch, locationId);
  const { data: customerResults } = useCustomersForSale(customerSearch);

  const { data: configData, isError: configError } = useQuery({
    queryKey: ['pos-discount-config', branchId],
    queryFn:  async () => {
      try {
        return await getEffectiveConfig(DISCOUNT_KEYS);
      } catch (e) {
        showToast('Unable to load discount defaults; using fallback values.', 'info');
        throw e;
      }
    },
    enabled:   branchId !== null,
    staleTime: 60_000,
    retry:     false,
  });

  // The most this cashier may discount a line, as the API checks it; unknown until the settings load.
  const discountLimits = configData?.items.find(item => item.key === 'max_line_discount_pct')?.value;
  const maxPct = discountLimits === undefined ? null : maxDiscountPct(discountLimits, me);

  // ── Config effect ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!configData?.items) return;
    const configMap = Object.fromEntries(configData.items.map(item => [item.key, item.value]));
    const rawType   = String(configMap.default_discount_type ?? 'Normal');
    const type      = isDiscountPresetType(rawType) ? rawType : 'Normal';
    setDefaultDiscountType(type);

    const presetSource = (typeKey: string) =>
      configData.items.find(item => item.key === typeKey)?.source ?? 'system';

    setDiscountPresets({
      Normal: {
        mode:   String(configMap.default_discount_mode_normal ?? 'Percentage') as 'Percentage' | 'Amount',
        value:  Number(configMap.default_discount_value_normal ?? 0),
        source: presetSource('default_discount_mode_normal'),
      },
      Merchant: {
        mode:   String(configMap.default_discount_mode_merchant ?? 'Percentage') as 'Percentage' | 'Amount',
        value:  Number(configMap.default_discount_value_merchant ?? 0),
        source: presetSource('default_discount_mode_merchant'),
      },
      Special: {
        mode:   String(configMap.default_discount_mode_special ?? 'Percentage') as 'Percentage' | 'Amount',
        value:  Number(configMap.default_discount_value_special ?? 0),
        source: presetSource('default_discount_mode_special'),
      },
    });
  }, [configData]);

  // ── Auto-select default location ───────────────────────────────────────────

  const locations = locData?.items ?? [];
  useEffect(() => {
    if (locations.length > 0 && locationId === null) {
      const def = locations.find(l => l.isDefaultFulfillment) ?? locations[0];
      setLocationId(def.id);
    }
  }, [locations, locationId]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F8') { e.preventDefault(); bookSearchRef.current?.focus(); }
      if (e.key === 'F9') { e.preventDefault(); customerSearchRef.current?.focus(); }
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); handleCompleteSale(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  // ── Derived totals ─────────────────────────────────────────────────────────

  const totals = cartTotals(cart);
  const remainingDue = totals.grandTotal.minus(paidTotal(paymentLines));
  const subtotal = totals.subtotal.toNumber();
  const discountTotal = totals.discountTotal.toNumber();
  const grandTotal = totals.grandTotal.toNumber();
  const remaining = remainingDue.toNumber();

  // ── Mutations ──────────────────────────────────────────────────────────────

  const createSale = useCreateSale();

  const quickAddMut = useMutation({
    mutationFn: (payload: QuickCustomerPayload) => createCustomer(payload),
    onSuccess:  (customer) => {
      setSelectedCustomer(customer);
      setShowQuickAdd(false);
      setCustomerSearch('');
      showToast(`Customer "${customer.fullName}" added`, 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // ── Cart helpers ───────────────────────────────────────────────────────────

  const checkDivergence = useCallback((item: CartLine): boolean => {
    const preset = discountPresets[item.discountType as DiscountPresetType];
    if (!preset || preset.source === 'unset') return false;
    if (item.discountMode !== preset.mode) return true;
    const presetVal = preset.value;
    if (item.discountMode === 'Percentage') return Math.abs(item.discountPct - presetVal) > 0.001;
    return Math.abs(item.discountAmount - presetVal) > 0.001;
  }, [discountPresets]);

  function addToCart(book: BookWithAvailability) {
    const price    = book.branchPrice ?? book.defaultPrice ?? 0;
    const existing = cart.find(i => i.bookId === book.id);
    if (existing) {
      setCart(c => c.map(i => i.bookId === book.id ? recalcLine({ ...i, quantity: i.quantity + 1 }) : i));
    } else {
      const newItem = recalcLine({
        bookId:         book.id,
        bookTitle:      book.title,
        bookIsbn:       book.isbn,
        quantity:       1,
        unitPrice:      price,
        discountPct:    activeDiscountPreset.mode === 'Percentage' ? activeDiscountPreset.value : 0,
        discountAmount: activeDiscountPreset.mode === 'Amount'     ? activeDiscountPreset.value : 0,
        discountType:   defaultDiscountType,
        discountMode:   activeDiscountPreset.mode,
        lineTotal:      price,
        isDivergent:    false,
      });
      setCart(c => [...c, newItem]);
      setBookSearch('');
    }
  }

  function updateQty(bookId: number, delta: number) {
    setCart(c => c.map(i => {
      if (i.bookId !== bookId) return i;
      const updated = recalcLine({ ...i, quantity: Math.max(1, i.quantity + delta) });
      return { ...updated, isDivergent: checkDivergence(updated) };
    }));
  }

  function updateDiscountValue(bookId: number, rawValue: number) {
    setCart(c => c.map(i => {
      if (i.bookId !== bookId) return i;
      const lineBase = Money.of(i.unitPrice).times(i.quantity);
      let next: CartLine;
      if (i.discountMode === 'Percentage') {
        const pct = Math.max(0, Math.min(100, rawValue));
        next = recalcLine({ ...i, discountPct: pct, discountAmount: lineBase.percent(pct).round(2).toNumber() });
      } else {
        const amt = Money.max(Money.ZERO, Money.min(lineBase, Money.of(rawValue || 0)));
        const pct = lineBase.isZero() ? 0 : Number(amt.times(100).dividedBy(lineBase.toFixed(2)).toFixed(4));
        next = recalcLine({ ...i, discountAmount: amt.toNumber(), discountPct: pct });
      }
      return { ...next, isDivergent: checkDivergence(next) };
    }));
  }

  function updateDiscountType(bookId: number, type: string) {
    // When type changes, auto-load the preset for that type
    const preset = discountPresets[type as DiscountPresetType];
    setCart(c => c.map(i => {
      if (i.bookId !== bookId) return i;
      let updated: CartLine;
      if (preset && preset.source !== 'unset') {
        const lineBase = Money.of(i.unitPrice).times(i.quantity);
        const discPct = preset.mode === 'Percentage' ? preset.value
          : (lineBase.isZero() ? 0 : Number(Money.of(preset.value).times(100).dividedBy(lineBase.toFixed(2)).toFixed(4)));
        const discAmt = preset.mode === 'Amount' ? preset.value : lineBase.percent(preset.value).round(2).toNumber();
        updated = recalcLine({ ...i, discountType: type, discountMode: preset.mode, discountPct: discPct, discountAmount: discAmt });
      } else {
        updated = { ...i, discountType: type };
      }
      return { ...updated, isDivergent: false };
    }));
  }

  function updateDiscountMode(bookId: number, mode: string) {
    setCart(c => c.map(i => {
      if (i.bookId !== bookId) return i;
      const updated = recalcLine({
        ...i,
        discountMode:   mode,
        discountPct:    mode === 'Percentage' ? i.discountPct : 0,
        discountAmount: mode === 'Amount'     ? i.discountAmount : 0,
      });
      return { ...updated, isDivergent: checkDivergence(updated) };
    }));
  }

  function removeFromCart(bookId: number) { setCart(c => c.filter(i => i.bookId !== bookId)); }

  // ── Payment helpers ────────────────────────────────────────────────────────

  function addPayment() {
    const raw = payAmount.trim() !== '' ? payAmount.trim() : remainingDue.toFixed(2);
    if (!isAmount(raw)) { showToast(AMOUNT_MESSAGE, 'error'); return; }
    if (payMethod === 'bank' && bankAccountRequired && !payBankAccountId) { showToast('Select a bank account', 'error'); return; }
    const missing = proofError(payMethod, payProof) ?? tenderProblem(payMethod, Money.of(raw), selectedCustomer, paymentLines);
    if (missing) { showToast(missing, 'error'); return; }
    const amount = payMethod === 'cash' ? cashLine(raw, remainingDue) : { amount: Money.of(raw).toFixed(2) };
    setPaymentLines(prev => [...prev, {
      method: payMethod, ...amount, bankAccountId: payMethod === 'bank' && payBankAccountId ? Number(payBankAccountId) : undefined,
      ...proofFields(payMethod, payProof),
    }]);
    setPayAmount('');
    setPayProof(EMPTY_PROOF);
  }

  function removePayment(idx: number) { setPaymentLines(prev => prev.filter((_, i) => i !== idx)); }

  function buildPaymentPayload() {
    return paymentLines.map(p => ({
      method: p.method as PaymentMethod & ('cash' | 'bank' | 'mobile' | 'store_credit' | 'loyalty_points'),
      amount: Money.of(p.amount).toNumber(),
      bankAccountId: p.bankAccountId, payerBank: p.payerBank, reference: p.reference,
    }));
  }

  /** What stops the sale before it is sent, or null: a line discounted more than this cashier may give. */
  function discountProblem(): string | null {
    if (maxPct === null) return null;
    const over = lineOverLimit(cart, maxPct);
    return over ? `The discount on "${over.bookTitle}" is more than your limit of ${maxPct}%` : null;
  }

  function sell(body: { customerId: number | null; allowCredit: boolean; dueDate?: string | null }) {
    const change = Money.sum(paymentLines.map(changeOf));
    createSale.mutate({
      locationId: locationId!,
      items: cart.map(i => ({ bookId: i.bookId, quantity: i.quantity, discountPct: i.discountPct, discountAmount: i.discountAmount, discountType: i.discountType as DiscountPresetType, discountMode: i.discountMode as 'Percentage' | 'Amount' })),
      payments: buildPaymentPayload(),
      ...body,
    }, {
      onSuccess: (tx) => { setReceipt({ ...tx, change }); showToast(`Sale ${tx.transactionNumber} completed`, 'success'); },
      onError:   (e: Error) => showToast(e.message, 'error'),
    });
  }

  function handleCompleteSale() {
    if (!locationId) { showToast('Select a location', 'error'); return; }
    if (cart.length === 0) { showToast('Cart is empty', 'error'); return; }
    if (remainingDue.abs().greaterThan('0.01')) { showToast(`Remaining balance: ${currency} ${remainingDue.toFixed(2)}`, 'error'); return; }
    const problem = discountProblem();
    if (problem) { showToast(problem, 'error'); return; }
    sell({ customerId: selectedCustomer?.id ?? null, allowCredit: false });
  }

  function completeCreditSale() {
    if (!locationId) { showToast('Select a location', 'error'); return; }
    if (cart.length === 0) { showToast('Cart is empty', 'error'); return; }
    if (!selectedCustomer) { showToast('Credit sales require a customer', 'error'); return; }
    const problem = discountProblem();
    if (problem) { showToast(problem, 'error'); return; }
    sell({ customerId: selectedCustomer.id, allowCredit: true, dueDate: dueDate || null });
  }

  function newSale() { setCart([]); setPaymentLines([]); setSelectedCustomer(null); setReceipt(null); setPayAmount(''); setDueDate(''); }

  const isSelling = createSale.isPending;

  // ── Stock badge ────────────────────────────────────────────────────────────

  function stockBadge(qty: number | null | undefined) {
    if (qty == null) return null;
    if (qty === 0) return <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">Out</span>;
    if (qty <= 5)  return <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">⚠{qty}</span>;
    return               <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">✓{qty}</span>;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  RECEIPT VIEW
  // ─────────────────────────────────────────────────────────────────────────────

  if (receipt) {
    return (
      <div className="flex items-center justify-center min-h-full bg-gray-50 dark:bg-gray-950 p-6">
        <style>{RECEIPT_PRINT_CSS}</style>
        <div className="w-full max-w-md">
          <div id="pos-receipt" className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-xl overflow-hidden">
            <div className={`px-6 py-5 text-center ${receipt.paymentStatus === 'paid' ? 'bg-linear-to-br from-emerald-500 to-teal-600' : 'bg-linear-to-br from-amber-500 to-orange-600'}`}>
              <div className="text-4xl mb-2">{receipt.paymentStatus === 'paid' ? '✅' : '🟡'}</div>
              <div className="flex items-center justify-center gap-1.5">
                <h2 className="text-xl font-bold text-white">{receipt.transactionNumber}</h2>
                <button
                  type="button"
                  title="Copy Transaction ID"
                  onClick={() => {
                    navigator.clipboard.writeText(receipt.transactionNumber)
                      .then(() => showToast('Transaction ID copied', 'success'))
                      .catch(() => showToast('Could not copy — copy manually', 'error'));
                  }}
                  className="no-print text-white/70 hover:text-white transition-colors p-1 rounded-md hover:bg-white/10"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                </button>
              </div>
              <p className="text-sm text-white/80 mt-1">{new Date(receipt.createdAt).toLocaleString()}</p>
              {receipt.paymentStatus !== 'paid' && (
                <div className="space-y-1 mt-2">
                  <span className="inline-block text-xs font-semibold px-3 py-1 rounded-full bg-white/20 text-white backdrop-blur-sm">
                    {receipt.paymentStatus === 'partial' ? `Partial — ${currency} ${Number(receipt.amountDue).toFixed(2)} due` : `Credit — ${currency} ${Number(receipt.amountDue).toFixed(2)} due`}
                  </span>
                  {receipt.dueDate && (
                    <p className="text-xs text-white/90 font-medium">Due Date: {localDay(receipt.dueDate)}</p>
                  )}
                </div>
              )}
            </div>
            <div className="p-6 space-y-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800">
                    {['Item', 'Qty', 'Price', 'Total'].map(h => (
                      <th key={h} className="pb-2 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-800/50">
                  {(receipt.lineItems ?? []).map((li, i) => (
                    <tr key={i}>
                      <td className="py-2 text-xs font-medium text-gray-900 dark:text-white">{li.bookTitle}</td>
                      <td className="py-2 text-xs text-gray-500">{li.quantity}</td>
                      <td className="py-2 text-xs text-gray-500">{Number(li.unitPrice).toFixed(2)}</td>
                      <td className="py-2 text-xs font-semibold text-gray-900 dark:text-white tabular-nums">{Number(li.lineTotal).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t border-gray-100 dark:border-gray-800 pt-4 space-y-2">
                <div className="flex justify-between text-sm text-gray-500"><span>Subtotal</span><span className="tabular-nums">{currency} {Number(receipt.subtotal).toFixed(2)}</span></div>
                {Number(receipt.discountTotal) > 0 && (
                  <div className="flex justify-between text-sm text-emerald-600"><span>Discount</span><span className="tabular-nums">-{currency} {Number(receipt.discountTotal).toFixed(2)}</span></div>
                )}
                <div className="flex justify-between text-base font-bold text-gray-900 dark:text-white border-t border-gray-100 dark:border-gray-800 pt-2">
                  <span>Total</span><span className="tabular-nums">{currency} {Number(receipt.grandTotal).toFixed(2)}</span>
                </div>
              </div>
              {(receipt.payments ?? []).length > 0 && (
                <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3 space-y-1.5">
                  {(receipt.payments ?? []).map((p, i) => (
                    <div key={i} className="flex justify-between text-sm">
                      <span className="text-gray-500">
                        {paymentMethodPlainLabel(p.method)}
                        {proofLabel(p) && <span className="block text-xs text-gray-400">{proofLabel(p)}</span>}
                      </span>
                      <span className="font-medium text-gray-900 dark:text-white tabular-nums">{currency} {Number(p.amount).toFixed(2)}</span>
                    </div>
                  ))}
                  {receipt.change.greaterThan(0) && (
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">Change</span>
                      <span className="font-medium text-gray-900 dark:text-white tabular-nums">{currency} {receipt.change.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              )}
              <div className="no-print flex gap-3 pt-1">
                <button onClick={() => window.print()} className="flex-1 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-sm font-semibold py-2.5 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">🖨 Print</button>
                <button onClick={newSale} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2.5 rounded-xl transition-colors shadow-md shadow-blue-600/20">＋ New Sale</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  MAIN POS LAYOUT
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-950 select-none">

      {tabBar}

      {view === 'history' && history}

      {/* ── POS Terminal tab ─────────────────────────────────────────────────── */}
      {view === 'pos' && (
        <div className="flex flex-1 overflow-hidden min-h-0">

          {/* ══════════════════════════════════════════════════
              LEFT PANEL — Customer + Book Search (22%)
          ══════════════════════════════════════════════════ */}
          <div className="w-64 xl:w-72 shrink-0 flex flex-col border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">

            {/* Customer */}
            <div className="shrink-0 px-3 pt-2.5 pb-2 border-b border-gray-100 dark:border-gray-800">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Customer</span>
                {!selectedCustomer && !showQuickAdd && (
                  <button
                    id="pos-quick-add-customer"
                    onClick={() => setShowQuickAdd(true)}
                    className="flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 px-1.5 py-0.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" /></svg>
                    Quick Add
                  </button>
                )}
              </div>

              {showQuickAdd && (
                <QuickAddCustomer
                  onSave={(payload) => quickAddMut.mutate(payload)}
                  onCancel={() => setShowQuickAdd(false)}
                  isSaving={quickAddMut.isPending}
                />
              )}

              {!showQuickAdd && selectedCustomer ? (
                <div className="flex items-center gap-2 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/50 rounded-lg px-2.5 py-2">
                  <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
                    <span className="text-xs font-bold text-white">{selectedCustomer.fullName.charAt(0).toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-gray-900 dark:text-white truncate">{selectedCustomer.fullName}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-xs text-amber-600 dark:text-amber-400">⭐{selectedCustomer.loyaltyBalance}</span>
                      <span className="text-xs text-gray-300">·</span>
                      <span className="text-xs text-emerald-600 dark:text-emerald-400">💳{Number(selectedCustomer.storeCreditBalance).toFixed(0)}</span>
                    </div>
                  </div>
                  <button onClick={() => setSelectedCustomer(null)} className="text-gray-400 hover:text-red-500 p-0.5 rounded-sm transition-colors" aria-label="Remove customer">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              ) : !showQuickAdd && (
                <div className="relative">
                  <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <input
                    ref={customerSearchRef}
                    id="pos-customer-search"
                    type="text"
                    value={customerSearch}
                    onChange={e => setCustomerSearch(e.target.value)}
                    placeholder="Search customer… (F9)"
                    className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:bg-white dark:focus:bg-gray-750 transition-colors"
                  />
                  {(customerResults?.items ?? []).length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl z-20 overflow-hidden">
                      {(customerResults?.items ?? []).map(c => (
                        <button key={c.id} onClick={() => { setSelectedCustomer(c); setCustomerSearch(''); }} className="w-full text-left px-3 py-2 hover:bg-blue-50 dark:hover:bg-blue-950/20 transition-colors border-b border-gray-50 dark:border-gray-800 last:border-b-0">
                          <p className="text-xs font-semibold text-gray-900 dark:text-white">{c.fullName}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{c.customerCode}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Book search */}
            <div className="px-3 pt-2 pb-2 border-b border-gray-100 dark:border-gray-800 shrink-0">
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5 block">Books (F8)</span>
              <div className="relative">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                <input
                  ref={bookSearchRef}
                  id="pos-book-search"
                  type="text"
                  value={bookSearch}
                  onChange={e => setBookSearch(e.target.value)}
                  placeholder="Title, ISBN, Author…"
                  autoFocus
                  className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:bg-white dark:focus:bg-gray-750 transition-colors"
                />
              </div>
            </div>

            {/* Book results */}
            <div className="flex-1 overflow-y-auto">
              {(bookResults?.items ?? []).length > 0 ? (
                bookResults!.items.map(b => (
                  <button
                    key={b.id}
                    id={`pos-book-${b.id}`}
                    onClick={() => addToCart(b)}
                    disabled={!allowNegative && b.availability != null && b.availability.available <= 0}
                    className={`w-full text-left px-3 py-2 border-b border-gray-50 dark:border-gray-800/60 transition-colors ${!allowNegative && b.availability != null && b.availability.available <= 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-50 dark:hover:bg-blue-950/20 active:bg-blue-100'}`}
                  >
                    <div className="flex items-start justify-between gap-1.5">
                      <p className="text-xs font-semibold text-gray-900 dark:text-white truncate leading-tight flex-1 min-w-0">{b.title}</p>
                      <p className="text-xs font-bold text-blue-700 dark:text-blue-400 tabular-nums shrink-0">{(b.branchPrice ?? b.defaultPrice ?? 0).toFixed(2)}</p>
                    </div>
                    <div className="flex items-center justify-between mt-0.5">
                      <p className="text-xs text-gray-400 truncate">{b.isbn}</p>
                      {b.availability != null && stockBadge(b.availability.available)}
                    </div>
                    {b.availability != null && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        📍 {b.availability.locationName ?? 'Location'} · On hand: {b.availability.onHand} · Reserved: {b.availability.reserved}
                      </p>
                    )}
                  </button>
                ))
              ) : bookSearch.length > 1 ? (
                <div className="flex flex-col items-center justify-center py-10 text-gray-400"><span className="text-2xl mb-1">📚</span><p className="text-xs">No books found</p></div>
              ) : (
                <div className="flex flex-col items-center justify-center py-10 text-gray-300 dark:text-gray-700"><span className="text-2xl mb-1">🔍</span><p className="text-xs text-center px-4">Search by title, ISBN or author</p></div>
              )}
            </div>
          </div>

          {/* ══════════════════════════════════════════════════
              CENTER PANEL — Cart (primary, ~50%)
          ══════════════════════════════════════════════════ */}
          <div className="flex-1 flex flex-col overflow-hidden bg-gray-50 dark:bg-gray-950 min-w-0">

            {/* Cart header */}
            <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-gray-900 dark:text-white">Cart</span>
                {cart.length > 0 && (
                  <span className="inline-flex items-center justify-center w-5 h-5 text-xs font-bold bg-blue-600 text-white rounded-full">{cart.length}</span>
                )}
              </div>
              {cart.length > 0 && (
                <button
                  onClick={() => setCart([])}
                  className="text-xs font-semibold text-red-500 hover:text-red-700 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  Clear
                </button>
              )}
            </div>

            {/* Cart body */}
            {cart.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-gray-300 dark:text-gray-700">
                <span className="text-5xl mb-3">🛒</span>
                <p className="text-sm font-medium text-gray-400 dark:text-gray-600">Cart is empty</p>
                <p className="text-xs text-gray-300 dark:text-gray-700 mt-1">Search for books on the left to add them</p>
              </div>
            ) : (
              <div className="flex-1 overflow-auto">
                {/* Cart table — compact rows */}
                <table className="w-full text-sm" style={{ minWidth: '600px' }}>
                  <thead className="sticky top-0 z-10 bg-gray-100 dark:bg-gray-800/90 backdrop-blur-xs border-b border-gray-200 dark:border-gray-700">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Book</th>
                      <th className="px-2 py-2 text-center text-xs font-bold text-gray-500 uppercase tracking-wider w-24">Qty</th>
                      <th className="px-2 py-2 text-right text-xs font-bold text-gray-500 uppercase tracking-wider w-20">Unit</th>
                      <th className="px-2 py-2 text-left text-xs font-bold text-gray-500 uppercase tracking-wider w-52">Discount</th>
                      <th className="px-2 py-2 text-right text-xs font-bold text-gray-500 uppercase tracking-wider w-24">Total</th>
                      <th className="w-7"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800/60 bg-white dark:bg-gray-900">
                    {cart.map(item => (
                      <tr key={item.bookId} className="hover:bg-gray-50/60 dark:hover:bg-gray-800/20 transition-colors group">

                        {/* Book info — compact 2-line */}
                        <td className="px-3 py-2">
                          <p className="font-semibold text-gray-900 dark:text-white text-xs leading-tight truncate max-w-[180px]">{item.bookTitle}</p>
                          <p className="text-xs text-gray-400 mt-0.5 font-mono">{item.bookIsbn}</p>
                        </td>

                        {/* Qty */}
                        <td className="px-2 py-2">
                          <div className="flex items-center justify-center gap-0.5">
                            <button onClick={() => updateQty(item.bookId, -1)} className="w-6 h-6 flex items-center justify-center rounded-sm bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 font-bold text-sm transition-colors">−</button>
                            <span className="w-7 text-center font-bold text-gray-900 dark:text-white tabular-nums text-xs">{item.quantity}</span>
                            <button onClick={() => updateQty(item.bookId, 1)} className="w-6 h-6 flex items-center justify-center rounded-sm bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 font-bold text-sm transition-colors">＋</button>
                          </div>
                        </td>

                        {/* Unit price */}
                        <td className="px-2 py-2 text-right text-xs font-medium text-gray-600 dark:text-gray-400 tabular-nums whitespace-nowrap">
                          {item.unitPrice.toFixed(2)}
                        </td>

                        {/* Discount — inline compact controls */}
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1">
                            {/* Type dropdown — auto-loads preset on change */}
                            <select
                              value={item.discountType}
                              onChange={e => updateDiscountType(item.bookId, e.target.value)}
                              className="w-20 px-1 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded-md bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-hidden focus:ring-1 focus:ring-blue-500"
                            >
                              <option value="Normal">Normal</option>
                              <option value="Merchant">Merchant</option>
                              <option value="Special">Special</option>
                            </select>

                            {/* Mode toggle: % / Amt */}
                            <button
                              onClick={() => updateDiscountMode(item.bookId, item.discountMode === 'Percentage' ? 'Amount' : 'Percentage')}
                              className={`px-1.5 py-1 text-xs font-bold rounded border transition-colors min-w-[22px] text-center ${
                                item.discountMode === 'Percentage'
                                  ? 'bg-violet-50 border-violet-300 text-violet-700 dark:bg-violet-900/30 dark:border-violet-700 dark:text-violet-400'
                                  : 'bg-amber-50 border-amber-300 text-amber-700 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-400'
                              }`}
                              title={`Switch to ${item.discountMode === 'Percentage' ? 'Amount' : 'Percentage'}`}
                            >
                              {item.discountMode === 'Percentage' ? '%' : 'ETB'}
                            </button>

                            {/* Value input */}
                            <div className="relative flex-1">
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={item.discountMode === 'Percentage' ? item.discountPct : item.discountAmount}
                                onChange={e => updateDiscountValue(item.bookId, Number(e.target.value))}
                                className={`w-full px-1.5 py-1 text-xs border rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-1 focus:ring-blue-500 tabular-nums ${
                                  item.isDivergent ? 'border-amber-400 dark:border-amber-600' : 'border-gray-200 dark:border-gray-700'
                                }`}
                              />
                              {item.isDivergent && (
                                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400 ring-1 ring-white dark:ring-gray-900" title="Overridden from default" />
                              )}
                            </div>
                          </div>

                          {/* Bidirectional preview — compact single line */}
                          {(item.discountPct > 0 || item.discountAmount > 0) && (
                            <p className="text-xs text-gray-400 mt-0.5 tabular-nums leading-tight">
                              {item.discountMode === 'Percentage'
                                ? `−${item.discountAmount.toFixed(2)}`
                                : `${((item.discountAmount / Math.max(item.unitPrice * item.quantity, 0.01)) * 100).toFixed(1)}%`
                              }
                            </p>
                          )}
                        </td>

                        {/* Line total */}
                        <td className="px-2 py-2 text-right">
                          <span className="font-bold text-gray-900 dark:text-white tabular-nums text-xs">{item.lineTotal.toFixed(2)}</span>
                          {item.discountAmount > 0 && (
                            <p className="text-xs text-emerald-600 dark:text-emerald-400 tabular-nums">−{item.discountAmount.toFixed(2)}</p>
                          )}
                        </td>

                        {/* Remove */}
                        <td className="pr-1">
                          <button
                            onClick={() => removeFromCart(item.bookId)}
                            className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-sm transition-all"
                            aria-label="Remove"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ══════════════════════════════════════════════════
              RIGHT PANEL — Summary + Payment + Actions (28%)
          ══════════════════════════════════════════════════ */}
          <div className="w-72 xl:w-80 shrink-0 flex flex-col border-l border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">

            {/* Location — compact single row */}
            <div className="px-3 pt-2.5 pb-2 border-b border-gray-100 dark:border-gray-800 shrink-0">
              <div className="flex items-center gap-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider shrink-0">Location</label>
                <select
                  id="pos-location"
                  value={locationId ?? ''}
                  onChange={e => setLocationId(Number(e.target.value) || null)}
                  className="flex-1 min-w-0 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 truncate"
                >
                  <option value="">Select…</option>
                  {locations.map(l => (
                    <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' ★' : ''}</option>
                  ))}
                </select>
              </div>
              {configError && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 rounded-md px-2 py-1">
                  ⚠ Discount defaults unavailable
                </p>
              )}
            </div>

            {/* Totals — no tax */}
            <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800 shrink-0 bg-gray-50/40 dark:bg-gray-900/60">
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                  <span>Subtotal</span>
                  <span className="tabular-nums font-medium">{currency} {subtotal.toFixed(2)}</span>
                </div>
                {discountTotal > 0 && (
                  <div className="flex justify-between text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                    <span>Discount</span>
                    <span className="tabular-nums">−{currency} {discountTotal.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between items-baseline pt-1.5 border-t border-gray-200 dark:border-gray-700">
                  <span className="text-sm font-bold text-gray-900 dark:text-white">Total</span>
                  <span className="text-lg font-black text-gray-900 dark:text-white tabular-nums">{currency} {grandTotal.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* Payment section — scrollable middle */}
            <div className="flex-1 overflow-y-auto px-3 py-2.5 space-y-2.5 min-h-0">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Payment Method</p>

              {/* Method tabs — shared across POS/Payment Collection/Exchange settlement */}
              <PaymentMethodTabs methods={PAYMENT_TABS} value={payMethod} onChange={setPayMethod} columns={3} />

              {/* Bank account selector */}
              {payMethod === 'bank' && bankAccountRequired && (
                <BankAccountSelect accounts={bankAccounts} value={payBankAccountId || null} onChange={(id) => setPayBankAccountId(id ?? '')} />
              )}

              {/* Customer's bank and reference, or the Telebirr number */}
              <PaymentProofFields method={payMethod} value={payProof} onChange={setPayProof} />

              {/* Store credit info */}
              {payMethod === 'store_credit' && selectedCustomer && (
                <div className="bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/40 rounded-lg px-2.5 py-1.5 text-xs text-emerald-700 dark:text-emerald-400 font-semibold">
                  Available: {currency} {Number(selectedCustomer.storeCreditBalance).toFixed(2)}
                </div>
              )}

              {/* Loyalty info */}
              {payMethod === 'loyalty_points' && selectedCustomer && (
                <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 rounded-lg px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400 font-semibold">
                  ⭐ Available: {selectedCustomer.loyaltyBalance} pts
                </div>
              )}

              {/* Quick fill + amount row */}
              <div className="flex gap-1.5 items-center">
                <input
                  ref={payAmountRef}
                  id="pos-pay-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={payAmount}
                  onChange={e => setPayAmount(e.target.value)}
                  placeholder={remaining > 0 ? remaining.toFixed(2) : '0.00'}
                  onKeyDown={e => e.key === 'Enter' && addPayment()}
                  className="flex-1 min-w-0 px-2.5 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500 tabular-nums"
                />
                {remaining > 0.01 && (
                  <button
                    onClick={() => setPayAmount(remaining.toFixed(2))}
                    className="text-xs px-2 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800/50 hover:bg-blue-100 transition-colors font-semibold shrink-0 whitespace-nowrap"
                    title="Fill remaining amount"
                  >↙ All</button>
                )}
                <button
                  onClick={addPayment}
                  className="px-3 py-1.5 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs font-bold rounded-lg hover:bg-gray-700 dark:hover:bg-gray-300 transition-colors shrink-0"
                >Add</button>
              </div>

              {/* Payment lines */}
              {paymentLines.length > 0 && (
                <div className="space-y-1 bg-gray-50 dark:bg-gray-800/40 rounded-lg p-2">
                  {paymentLines.map((p, i) => (
                    <Fragment key={i}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-600 dark:text-gray-400 flex items-center gap-1 min-w-0">
                        <span>{PAYMENT_METHOD_META[p.method as PaymentMethodCode]?.icon}</span>
                        {paymentMethodPlainLabel(p.method)}
                        {proofLabel(p) && <span className="text-gray-400 truncate">· {proofLabel(p)}</span>}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-gray-900 dark:text-white tabular-nums">{currency} {Money.of(p.amount).toFixed(2)}</span>
                        <button onClick={() => removePayment(i)} className="text-gray-300 hover:text-red-500 transition-colors" aria-label="Remove payment">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    </div>
                    {p.tendered && (
                      <p className="text-xs text-gray-400 text-right tabular-nums">
                        Given {currency} {Money.of(p.tendered).toFixed(2)} · change {currency} {changeOf(p).toFixed(2)}
                      </p>
                    )}
                    </Fragment>
                  ))}
                </div>
              )}

              {/* Balance status */}
              {cart.length > 0 && (
                <div className={`flex justify-between items-center text-xs font-bold px-2.5 py-1.5 rounded-lg border ${
                  remaining > 0.01
                    ? 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/30'
                    : remaining < -0.01
                      ? 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900/30'
                      : 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900/30'
                }`}>
                  <span>{remaining > 0.01 ? '⏳ Due' : remaining < -0.01 ? '⚠ Over' : '✓ Settled'}</span>
                  <span className="tabular-nums">{currency} {Math.abs(remaining).toFixed(2)}</span>
                </div>
              )}
            </div>

            {/* ── Action buttons — always pinned to bottom ── */}
            {canCreate(userRole, userPermissions) && (
              <div className="px-3 py-2.5 space-y-1.5 shrink-0 border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">

                {/* Inline hints (compact) */}
                {!locationId && cart.length > 0 && (
                  <p className="text-xs text-amber-600 text-center bg-amber-50 dark:bg-amber-950/20 rounded-md py-1">⚠ Select a location</p>
                )}
                {remaining > 0.01 && !selectedCustomer && cart.length > 0 && (
                  <p className="text-xs text-gray-400 text-center">Add a customer for credit sale</p>
                )}

                {/* Complete Sale */}
                <button
                  id="pos-complete-sale"
                  onClick={handleCompleteSale}
                  disabled={isSelling || cart.length === 0 || !locationId || Math.abs(remaining) > 0.01}
                  className="w-full flex items-center justify-between gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-xl transition-colors shadow-md shadow-emerald-600/20 active:scale-[0.98]"
                >
                  <span className="text-sm">{isSelling ? '⏳ Processing…' : '✓ Complete Sale'}</span>
                  <span className="text-xs font-semibold opacity-90 tabular-nums flex items-center gap-1.5">
                    {currency} {grandTotal.toFixed(2)}
                    <span className="opacity-50 font-mono">Ctrl+↵</span>
                  </span>
                </button>

                {/* Due Date Picker for Credit Sale */}
                {remaining > 0.01 && selectedCustomer && (
                  <div className="space-y-1">
                    <label htmlFor="pos-due-date" className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">Due Date</label>
                    <input
                      id="pos-due-date"
                      type="date"
                      value={dueDate}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={e => setDueDate(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                )}

                {/* Credit Sale — only shown when there's an unpaid balance */}
                {remaining > 0.01 && (
                  <button
                    id="pos-credit-sale"
                    onClick={completeCreditSale}
                    disabled={isSelling || cart.length === 0 || !locationId || !selectedCustomer}
                    title={!selectedCustomer ? 'Select a customer to allow credit sale' : ''}
                    className="w-full flex items-center justify-between gap-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-2.5 px-4 rounded-xl transition-colors active:scale-[0.98]"
                  >
                    <span className="text-sm">📋 Credit Sale</span>
                    <span className="text-xs opacity-90 tabular-nums">Due {currency} {remaining.toFixed(2)}</span>
                  </button>
                )}
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
