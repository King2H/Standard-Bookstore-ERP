import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { useCurrency } from '../lib/useCurrency.js';
import QuickAddCustomer, { type QuickCustomerPayload } from '../components/QuickAddCustomer.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../components/Pagination.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type Role = string;

interface BookResult {
  id: number;
  title: string;
  isbn: string;
  defaultPrice: number | null;
  branchPrice: number | null;
  stockQuantity?: number | null;
  availability?: {
    locationId: number;
    locationName: string | null;
    onHand: number;
    reserved: number;
    available: number;
  } | null;
}

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

interface CartItem {
  bookId: number;
  bookTitle: string;
  bookIsbn: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  discountAmount: number;
  discountType: string;
  discountMode: string;
  lineTotal: number;
  isDivergent?: boolean;
}

interface Customer {
  id: number;
  customerCode: string;
  fullName: string;
  loyaltyBalance: number;
  storeCreditBalance: number;
}

interface Location { id: number; name: string; isDefaultFulfillment: boolean; }
interface BankAccount { id: number; accountName: string; bankName: string; maskedAccountNumber: string; currency: string; }

interface TransactionLine { bookTitle: string; quantity: number; unitPrice: number; discountAmount: number; lineTotal: number; }
interface TransactionPayment { method: string; amount: number; }

interface Transaction {
  id: string; transactionNumber: string;
  subtotal: number; discountTotal: number; grandTotal: number;
  amountPaid: number; amountDue: number;
  paymentStatus: 'paid' | 'partial' | 'credit';
  currency: string; status: string; createdAt: string;
  lineItems?: TransactionLine[]; payments?: TransactionPayment[];
  dueDate?: string | null;
}

interface TxListResponse { items: Transaction[]; total: number; page: number; totalPages: number; }
interface POSPageProps {
  userRole?: Role; userPermissions?: string[]; initialContext?: Record<string, string>;
  /** Single Authoritative Payment Collection Workflow: Sales History no
   *  longer collects payment directly — "View Payments" navigates to the
   *  Payments module's History tab, pre-filtered to this transaction. */
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}

// ── Permissions ───────────────────────────────────────────────────────────────

const canCreate = (r?: Role, perms?: string[]) =>
  (perms?.includes('CREATE_SALE')) || ['Sales', 'Manager', 'Admin', 'Super_Admin'].includes(r ?? '');
const canVoid = (r?: Role, perms?: string[]) =>
  (perms?.includes('MANAGE_STAFF')) || ['Manager', 'Admin', 'Super_Admin'].includes(r ?? '');

// ── Payment ───────────────────────────────────────────────────────────────────

type PaymentMethod = 'cash' | 'bank' | 'store_credit' | 'loyalty_points';
// Bug fix: 'store_credit' was mislabeled "Telebirr" here — transactions'
// payment method CHECK constraint has no separate 'mobile' value (unlike
// orders/payments, which do), so this tab was quietly standing in as a
// mobile-money button while actually debiting the customer's real store
// credit balance underneath (see the "Available: {storeCreditBalance}"
// panel below, which was always showing the correct — just mislabeled —
// balance). OrdersPage.tsx already treats these as two distinct, correctly
// labeled concepts ('mobile' = Telebirr, 'store_credit' = Store Credit);
// matching that here, since POS has no genuine Telebirr/mobile channel to
// conflate it with.
const PAYMENT_TABS: { method: PaymentMethod; label: string; icon: string }[] = [
  { method: 'cash',           label: 'Cash',         icon: '💵' },
  { method: 'bank',           label: 'Bank',         icon: '🏦' },
  { method: 'store_credit',   label: 'Store Credit', icon: '🎁' },
  { method: 'loyalty_points', label: 'Loyalty',      icon: '⭐' },
];

// ── Cart maths (no tax) ───────────────────────────────────────────────────────

function calcCart(items: CartItem[]) {
  const subtotalCents      = items.reduce((s, i) => s + Math.round(i.unitPrice * 100) * i.quantity, 0);
  const discountTotalCents = items.reduce((s, i) => s + Math.round(i.discountAmount * 100), 0);
  const grandTotalCents    = Math.max(0, subtotalCents - discountTotalCents);
  const result = {
    subtotal:      subtotalCents / 100,
    discountTotal: discountTotalCents / 100,
    grandTotal:    grandTotalCents / 100,
  };
  // Dev-mode diagnostic: log cart totals whenever they change
  if (import.meta.env.DEV && items.length > 0) {
    console.debug('[POS calcCart]', {
      subtotal: result.subtotal.toFixed(2),
      discountTotal: result.discountTotal.toFixed(2),
      grandTotal: result.grandTotal.toFixed(2),
      itemCount: items.length,
      items: items.map(i => ({
        title: i.bookTitle,
        qty: i.quantity,
        unitPrice: i.unitPrice,
        discountType: i.discountType,
        discountMode: i.discountMode,
        discountPct: i.discountPct,
        discountAmount: i.discountAmount,
        lineTotal: i.lineTotal,
      })),
    });
  }
  return result;
}

function recalcItem(item: CartItem): CartItem {
  const unitPriceCents           = Math.round(item.unitPrice * 100);
  const totalBeforeDiscountCents = unitPriceCents * item.quantity;
  const discountAmtCents         = item.discountMode === 'Percentage'
    ? Math.round(totalBeforeDiscountCents * (item.discountPct / 100))
    : Math.round(item.discountAmount * 100);
  const clampedDiscountCents = Math.max(0, Math.min(totalBeforeDiscountCents, discountAmtCents));
  const lineTotalCents       = Math.max(0, totalBeforeDiscountCents - clampedDiscountCents);
  return {
    ...item,
    discountAmount: clampedDiscountCents / 100,
    lineTotal:      lineTotalCents / 100,
  };
}

// ── Tab type ──────────────────────────────────────────────────────────────────

type Tab = 'pos' | 'history';

// ─────────────────────────────────────────────────────────────────────────────
//  Main Component
// ─────────────────────────────────────────────────────────────────────────────

export default function POSPage({ userRole, userPermissions, initialContext = {}, onNavigate }: POSPageProps) {
  const qc          = useQueryClient();
  const { showToast } = useToast();
  const currency    = useCurrency();
  // Module 6: the dashboard's Today's Sales KPI drill-down passes a date
  // range and expects the Sales History tab, pre-filtered — this page used
  // to ignore initialContext entirely and always land on the POS terminal.
  const [tab, setTab] = useState<Tab>(initialContext.dateFrom || initialContext.dateTo ? 'history' : 'pos');
  const [histDateFrom, setHistDateFrom] = useState(initialContext.dateFrom ?? '');
  const [histDateTo, setHistDateTo] = useState(initialContext.dateTo ?? '');

  // ── POS state ──────────────────────────────────────────────────────────────
  const [bookSearch, setBookSearch]               = useState('');
  const [cart, setCart]                           = useState<CartItem[]>([]);
  const [selectedCustomer, setSelectedCustomer]   = useState<Customer | null>(null);
  const [dueDate, setDueDate]                     = useState<string>('');
  const [customerSearch, setCustomerSearch]       = useState('');
  const [showQuickAdd, setShowQuickAdd]           = useState(false);
  const [locationId, setLocationId]               = useState<number | null>(null);
  const [paymentLines, setPaymentLines]           = useState<Array<{ method: PaymentMethod; amount: string; bankAccountId?: number }>>([]);
  const [payMethod, setPayMethod]                 = useState<PaymentMethod>('cash');
  const [payAmount, setPayAmount]                 = useState('');
  const [payBankAccountId, setPayBankAccountId]   = useState<number | ''>('');
  const [receipt, setReceipt]                     = useState<Transaction | null>(null);
  const [histPage, setHistPage]                   = useState(1);
  const [histPageSize, setHistPageSize]           = useState(DEFAULT_PAGE_SIZE);

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

  const { data: locData } = useQuery<{ items: Location[] }>({
    queryKey: ['pos-locations', branchId],
    queryFn:  () => api.get(`/branches/${branchId}/locations?pageSize=50`),
    enabled:  branchId !== null,
  });

  const { data: bankData } = useQuery<{ items: BankAccount[] }>({
    queryKey: ['pos-bank-accounts', branchId],
    queryFn:  () => api.get(`/branches/${branchId}/bank-accounts?isActive=true&pageSize=50`),
    enabled:  branchId !== null && payMethod === 'bank',
  });

  const { data: bookResults } = useQuery<{ items: BookResult[] }>({
    queryKey: ['pos-books', bookSearch, locationId, branchId],
    queryFn:  () => api.get(`/books/with-availability?q=${encodeURIComponent(bookSearch)}&pageSize=10&branchId=${branchId}${locationId ? `&locationId=${locationId}` : ''}`),
    enabled:  branchId !== null && bookSearch.length > 1,
  });

  const { data: customerResults } = useQuery<{ items: Customer[] }>({
    queryKey: ['pos-customers', customerSearch, branchId],
    queryFn:  () => api.get(`/customers?q=${encodeURIComponent(customerSearch)}&pageSize=5`),
    enabled:  branchId !== null && customerSearch.length > 1,
  });

  const { data: histData, isLoading: histLoading } = useQuery<TxListResponse>({
    queryKey: ['pos-history', histPage, histPageSize, branchId, histDateFrom, histDateTo],
    queryFn:  () => api.get(`/pos/transactions?branchId=${branchId}&page=${histPage}&pageSize=${histPageSize}${histDateFrom ? `&dateFrom=${histDateFrom}` : ''}${histDateTo ? `&dateTo=${histDateTo}` : ''}`),
    enabled:  branchId !== null && tab === 'history',
  });

  const { data: configData, isError: configError } = useQuery({
    queryKey: ['pos-discount-config', branchId],
    queryFn:  async () => {
      try {
        return await api.get<{ items: Array<{ key: string; value: unknown; source?: 'branch' | 'system' }> }>(
          `/config/effective?keys=default_discount_type,default_discount_mode_normal,default_discount_value_normal,default_discount_mode_merchant,default_discount_value_merchant,default_discount_mode_special,default_discount_value_special`,
        );
      } catch (e) {
        showToast('Unable to load discount defaults; using fallback values.', 'info');
        throw e;
      }
    },
    enabled:   branchId !== null,
    staleTime: 60_000,
    retry:     false,
  });

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

  const { subtotal, discountTotal, grandTotal } = calcCart(cart);
  const paidTotal = parseFloat(paymentLines.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0).toFixed(2));
  const remaining = parseFloat((grandTotal - paidTotal).toFixed(2));

  // ── Mutations ──────────────────────────────────────────────────────────────

  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<Transaction>('/pos/transactions', body),
    onSuccess:  (tx) => { setReceipt(tx); showToast(`Sale ${tx.transactionNumber} completed`, 'success'); },
    onError:    (e: Error) => showToast(e.message, 'error'),
  });

  const voidMut = useMutation({
    mutationFn: (id: string) => api.post<Transaction>(`/pos/transactions/${id}/void`),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['pos-history'] }); showToast('Transaction voided', 'success'); },
    onError:    (e: Error) => showToast(e.message, 'error'),
  });

  const quickAddMut = useMutation({
    mutationFn: (payload: QuickCustomerPayload) => api.post<Customer>('/customers', payload),
    onSuccess:  (customer) => {
      setSelectedCustomer(customer);
      setShowQuickAdd(false);
      setCustomerSearch('');
      showToast(`Customer "${customer.fullName}" added`, 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // ── Cart helpers ───────────────────────────────────────────────────────────

  const checkDivergence = useCallback((item: CartItem): boolean => {
    const preset = discountPresets[item.discountType as DiscountPresetType];
    if (!preset || preset.source === 'unset') return false;
    if (item.discountMode !== preset.mode) return true;
    const presetVal = preset.value;
    if (item.discountMode === 'Percentage') return Math.abs(item.discountPct - presetVal) > 0.001;
    return Math.abs(item.discountAmount - presetVal) > 0.001;
  }, [discountPresets]);

  function addToCart(book: BookResult) {
    const price    = book.branchPrice ?? book.defaultPrice ?? 0;
    const existing = cart.find(i => i.bookId === book.id);
    if (existing) {
      setCart(c => c.map(i => i.bookId === book.id ? recalcItem({ ...i, quantity: i.quantity + 1 }) : i));
    } else {
      const newItem = recalcItem({
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
      const updated = recalcItem({ ...i, quantity: Math.max(1, i.quantity + delta) });
      return { ...updated, isDivergent: checkDivergence(updated) };
    }));
  }

  function updateDiscountValue(bookId: number, rawValue: number) {
    setCart(c => c.map(i => {
      if (i.bookId !== bookId) return i;
      const lineBase = i.unitPrice * i.quantity;
      let next: CartItem;
      if (i.discountMode === 'Percentage') {
        const pct = Math.max(0, Math.min(100, rawValue));
        const amt = lineBase > 0 ? parseFloat(((pct / 100) * lineBase).toFixed(2)) : 0;
        next = recalcItem({ ...i, discountPct: pct, discountAmount: amt });
      } else {
        const amt = Math.max(0, Math.min(lineBase, rawValue));
        const pct = lineBase > 0 ? parseFloat(((amt / lineBase) * 100).toFixed(4)) : 0;
        next = recalcItem({ ...i, discountAmount: amt, discountPct: pct });
      }
      return { ...next, isDivergent: checkDivergence(next) };
    }));
  }

  function updateDiscountType(bookId: number, type: string) {
    // When type changes, auto-load the preset for that type
    const preset = discountPresets[type as DiscountPresetType];
    setCart(c => c.map(i => {
      if (i.bookId !== bookId) return i;
      let updated: CartItem;
      if (preset && preset.source !== 'unset') {
        const lineBase = i.unitPrice * i.quantity;
        const discPct = preset.mode === 'Percentage' ? preset.value : (lineBase > 0 ? parseFloat(((preset.value / lineBase) * 100).toFixed(4)) : 0);
        const discAmt = preset.mode === 'Amount' ? preset.value : parseFloat(((preset.value / 100) * lineBase).toFixed(2));
        updated = recalcItem({ ...i, discountType: type, discountMode: preset.mode, discountPct: discPct, discountAmount: discAmt });
      } else {
        updated = { ...i, discountType: type };
      }
      return { ...updated, isDivergent: false };
    }));
  }

  function updateDiscountMode(bookId: number, mode: string) {
    setCart(c => c.map(i => {
      if (i.bookId !== bookId) return i;
      const updated = recalcItem({
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
    const raw = payAmount.trim() !== '' ? payAmount : remaining.toFixed(2);
    const amt = parseFloat(raw);
    if (!amt || amt <= 0) return;
    if (payMethod === 'bank' && !payBankAccountId) { showToast('Select a bank account', 'error'); return; }
    setPaymentLines(prev => [...prev, { method: payMethod, amount: raw, bankAccountId: payMethod === 'bank' ? Number(payBankAccountId) : undefined }]);
    setPayAmount('');
  }

  function removePayment(idx: number) { setPaymentLines(prev => prev.filter((_, i) => i !== idx)); }

  function buildPaymentPayload() {
    return paymentLines.map(p => ({ method: p.method, amount: parseFloat(p.amount), reference: p.bankAccountId ? String(p.bankAccountId) : undefined }));
  }

  function handleCompleteSale() {
    if (!locationId) { showToast('Select a location', 'error'); return; }
    if (cart.length === 0) { showToast('Cart is empty', 'error'); return; }
    if (Math.abs(remaining) > 0.01) { showToast(`Remaining balance: ${currency} ${remaining.toFixed(2)}`, 'error'); return; }

    // Dev-mode: log exactly what is being submitted
    if (import.meta.env.DEV) {
      const paySum = parseFloat(paymentLines.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0).toFixed(2));
      console.debug('[POS handleCompleteSale]', {
        subtotal: subtotal.toFixed(2),
        discountTotal: discountTotal.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        paymentSum: paySum.toFixed(2),
        diff: (grandTotal - paySum).toFixed(4),
        payments: paymentLines,
        items: cart.map(i => ({
          bookId: i.bookId, qty: i.quantity,
          discountType: i.discountType, discountMode: i.discountMode,
          discountPct: i.discountPct, discountAmount: i.discountAmount,
          lineTotal: i.lineTotal,
        })),
      });
    }

    createMut.mutate({ branchId, locationId, customerId: selectedCustomer?.id ?? null, items: cart.map(i => ({ bookId: i.bookId, quantity: i.quantity, discountPct: i.discountPct, discountAmount: i.discountAmount, discountType: i.discountType, discountMode: i.discountMode })), payments: buildPaymentPayload(), allowCredit: false });
  }

  function completeCreditSale() {
    if (!locationId) { showToast('Select a location', 'error'); return; }
    if (cart.length === 0) { showToast('Cart is empty', 'error'); return; }
    if (!selectedCustomer) { showToast('Credit sales require a customer', 'error'); return; }

    if (import.meta.env.DEV) {
      const paySum = parseFloat(paymentLines.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0).toFixed(2));
      console.debug('[POS completeCreditSale]', {
        grandTotal: grandTotal.toFixed(2), paymentSum: paySum.toFixed(2), remaining: remaining.toFixed(2),
      });
    }

    createMut.mutate({ branchId, locationId, customerId: selectedCustomer.id, items: cart.map(i => ({ bookId: i.bookId, quantity: i.quantity, discountPct: i.discountPct, discountAmount: i.discountAmount, discountType: i.discountType, discountMode: i.discountMode })), payments: buildPaymentPayload(), allowCredit: true, dueDate: dueDate || null });
  }

  function newSale() { setCart([]); setPaymentLines([]); setSelectedCustomer(null); setReceipt(null); setPayAmount(''); setDueDate(''); }

  const bankAccounts = bankData?.items ?? [];

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
        <div className="w-full max-w-md">
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-xl overflow-hidden">
            <div className={`px-6 py-5 text-center ${receipt.paymentStatus === 'paid' ? 'bg-gradient-to-br from-emerald-500 to-teal-600' : 'bg-gradient-to-br from-amber-500 to-orange-600'}`}>
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
                  className="text-white/70 hover:text-white transition-colors p-1 rounded-md hover:bg-white/10"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                </button>
              </div>
              <p className="text-sm text-white/80 mt-1">{new Date(receipt.createdAt).toLocaleString()}</p>
              {receipt.paymentStatus !== 'paid' && (
                <div className="space-y-1 mt-2">
                  <span className="inline-block text-xs font-semibold px-3 py-1 rounded-full bg-white/20 text-white backdrop-blur">
                    {receipt.paymentStatus === 'partial' ? `Partial — ${currency} ${Number(receipt.amountDue).toFixed(2)} due` : `Credit — ${currency} ${Number(receipt.amountDue).toFixed(2)} due`}
                  </span>
                  {receipt.dueDate && (
                    <p className="text-xs text-white/90 font-medium">Due Date: {new Date(receipt.dueDate).toLocaleDateString()}</p>
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
                      <span className="text-gray-500 capitalize">{p.method === 'store_credit' ? 'Store Credit' : p.method.replace(/_/g, ' ')}</span>
                      <span className="font-medium text-gray-900 dark:text-white tabular-nums">{currency} {Number(p.amount).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-3 pt-1">
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

      {/* ── Tab bar ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-4 pt-1.5 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex-shrink-0">
        {(['pos', 'history'] as Tab[]).map(t => (
          <button
            key={t}
            id={`pos-tab-${t}`}
            onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {t === 'pos' ? '🛒 POS Terminal' : '📋 Sales History'}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 pb-1 text-xs text-gray-400 dark:text-gray-600 font-mono">
          <span><kbd className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-xs">F8</kbd> Books</span>
          <span><kbd className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-xs">F9</kbd> Customer</span>
          <span><kbd className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-xs">Ctrl+↵</kbd> Checkout</span>
        </div>
      </div>

      {/* ── History tab ──────────────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div className="flex-1 overflow-auto p-4">
          <div className="flex items-center gap-2 mb-3">
            <input type="date" value={histDateFrom} onChange={e => { setHistDateFrom(e.target.value); setHistPage(1); }}
              className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <span className="text-xs text-gray-400">to</span>
            <input type="date" value={histDateTo} onChange={e => { setHistDateTo(e.target.value); setHistPage(1); }}
              className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {(histDateFrom || histDateTo) && (
              <button onClick={() => { setHistDateFrom(''); setHistDateTo(''); setHistPage(1); }}
                className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                Clear
              </button>
            )}
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
            {histLoading ? (
              <div className="p-12 text-center">
                <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
                <p className="text-sm text-gray-400">Loading transactions…</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[800px]">
                  <thead className="bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
                    <tr>
                      {['Tx #', 'Total', 'Paid', 'Due', 'Status', 'Payment', 'Date', 'Actions'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {(histData?.items ?? []).map(tx => (
                      <tr key={tx.id} className="hover:bg-gray-50/80 dark:hover:bg-gray-800/40 transition-colors">
                        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap">
                          <button
                            type="button"
                            title="Copy Transaction ID"
                            onClick={() => {
                              navigator.clipboard.writeText(tx.transactionNumber)
                                .then(() => showToast('Transaction ID copied', 'success'))
                                .catch(() => showToast('Could not copy — copy manually', 'error'));
                            }}
                            className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline transition-colors"
                          >
                            {tx.transactionNumber}
                          </button>
                        </td>
                        <td className="px-4 py-3 font-semibold text-gray-900 dark:text-white tabular-nums whitespace-nowrap">{currency} {Number(tx.grandTotal).toFixed(2)}</td>
                        <td className="px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400 tabular-nums whitespace-nowrap">{currency} {Number(tx.amountPaid ?? tx.grandTotal).toFixed(2)}</td>
                        <td className="px-4 py-3 text-sm text-amber-700 dark:text-amber-400 tabular-nums whitespace-nowrap">
                          {Number(tx.amountDue ?? 0) > 0 ? (
                            <div>
                              <div>{currency} {Number(tx.amountDue).toFixed(2)}</div>
                              {tx.dueDate && <div className="text-[10px] text-gray-400 font-medium">Due: {tx.dueDate}</div>}
                            </div>
                          ) : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${tx.status === 'completed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>{tx.status}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${tx.paymentStatus === 'paid' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : tx.paymentStatus === 'partial' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>{tx.paymentStatus ?? 'paid'}</span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{new Date(tx.createdAt).toLocaleString()}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1">
                            {canVoid(userRole, userPermissions) && tx.status === 'completed' && (
                              <button onClick={() => { if (confirm('Void this transaction?')) voidMut.mutate(tx.id); }} className="text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 px-2 py-1 rounded-lg font-medium transition-colors whitespace-nowrap">Void</button>
                            )}
                            {/* Single Authoritative Payment Collection Workflow: Sales
                                History no longer collects payment itself (Payments is
                                the only module that can) — this deep-links into
                                Payments' Collect tab, pre-selected for this
                                transaction, matching Receivables' "Open in Payments".
                                Only shown for credit sales with an outstanding
                                balance (partial/credit) — fully paid transactions
                                have nothing left to collect. */}
                            {tx.status === 'completed' && (tx.paymentStatus === 'partial' || tx.paymentStatus === 'credit') && (
                              <button
                                onClick={() => onNavigate?.('payments', { orderId: tx.id, sourceType: 'pos' })}
                                className="text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 px-2 py-1 rounded-lg font-semibold transition-colors whitespace-nowrap"
                              >View Payments</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(!histData?.items || histData.items.length === 0) && !histLoading && (
              <div className="p-12 text-center"><div className="text-4xl mb-3">📋</div><p className="text-sm text-gray-400">No transactions found</p></div>
            )}
            {histData && (
              <Pagination
                page={histPage} pageSize={histPageSize} total={histData.total} totalPages={histData.totalPages}
                onPageChange={setHistPage} onPageSizeChange={makePageSizeHandler(setHistPage, setHistPageSize)}
                itemLabel="transaction"
              />
            )}
          </div>
        </div>
      )}

      {/* ── POS Terminal tab ─────────────────────────────────────────────────── */}
      {tab === 'pos' && (
        <div className="flex flex-1 overflow-hidden min-h-0">

          {/* ══════════════════════════════════════════════════
              LEFT PANEL — Customer + Book Search (22%)
          ══════════════════════════════════════════════════ */}
          <div className="w-64 xl:w-72 flex-shrink-0 flex flex-col border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">

            {/* Customer */}
            <div className="flex-shrink-0 px-3 pt-2.5 pb-2 border-b border-gray-100 dark:border-gray-800">
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
                  <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0">
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
                  <button onClick={() => setSelectedCustomer(null)} className="text-gray-400 hover:text-red-500 p-0.5 rounded transition-colors" aria-label="Remove customer">
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
                    className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white dark:focus:bg-gray-750 transition-colors"
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
            <div className="px-3 pt-2 pb-2 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
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
                  className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white dark:focus:bg-gray-750 transition-colors"
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
                    disabled={b.availability != null && b.availability.available === 0}
                    className={`w-full text-left px-3 py-2 border-b border-gray-50 dark:border-gray-800/60 transition-colors ${b.availability != null && b.availability.available === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-50 dark:hover:bg-blue-950/20 active:bg-blue-100'}`}
                  >
                    <div className="flex items-start justify-between gap-1.5">
                      <p className="text-xs font-semibold text-gray-900 dark:text-white truncate leading-tight flex-1 min-w-0">{b.title}</p>
                      <p className="text-xs font-bold text-blue-700 dark:text-blue-400 tabular-nums flex-shrink-0">{(b.branchPrice ?? b.defaultPrice ?? 0).toFixed(2)}</p>
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
            <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex items-center justify-between flex-shrink-0">
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
                  <thead className="sticky top-0 z-10 bg-gray-100 dark:bg-gray-800/90 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700">
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
                            <button onClick={() => updateQty(item.bookId, -1)} className="w-6 h-6 flex items-center justify-center rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 font-bold text-sm transition-colors">−</button>
                            <span className="w-7 text-center font-bold text-gray-900 dark:text-white tabular-nums text-xs">{item.quantity}</span>
                            <button onClick={() => updateQty(item.bookId, 1)} className="w-6 h-6 flex items-center justify-center rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 font-bold text-sm transition-colors">＋</button>
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
                              className="w-20 px-1 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded-md bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
                                className={`w-full px-1.5 py-1 text-xs border rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500 tabular-nums ${
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
                            className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded transition-all"
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
          <div className="w-72 xl:w-80 flex-shrink-0 flex flex-col border-l border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">

            {/* Location — compact single row */}
            <div className="px-3 pt-2.5 pb-2 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
              <div className="flex items-center gap-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider flex-shrink-0">Location</label>
                <select
                  id="pos-location"
                  value={locationId ?? ''}
                  onChange={e => setLocationId(Number(e.target.value) || null)}
                  className="flex-1 min-w-0 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 truncate"
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
            <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800 flex-shrink-0 bg-gray-50/40 dark:bg-gray-900/60">
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

              {/* Method tabs — compact 4-col grid */}
              <div className="grid grid-cols-4 gap-1">
                {PAYMENT_TABS.map(({ method, label, icon }) => (
                  <button
                    key={method}
                    id={`pos-pay-${method}`}
                    onClick={() => setPayMethod(method)}
                    className={`flex flex-col items-center gap-0.5 py-1.5 px-1 rounded-lg text-xs font-semibold transition-all ${
                      payMethod === method
                        ? 'bg-blue-600 text-white shadow-sm shadow-blue-600/30'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                    }`}
                  >
                    <span className="text-sm leading-none">{icon}</span>
                    <span className="leading-tight">{label}</span>
                  </button>
                ))}
              </div>

              {/* Bank account selector */}
              {payMethod === 'bank' && (
                <select
                  value={payBankAccountId}
                  onChange={e => setPayBankAccountId(Number(e.target.value) || '')}
                  className="w-full px-2.5 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select bank account…</option>
                  {bankAccounts.map(b => (
                    <option key={b.id} value={b.id}>{b.bankName} — {b.accountName}</option>
                  ))}
                </select>
              )}

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
                  className="flex-1 min-w-0 px-2.5 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
                />
                {remaining > 0.01 && (
                  <button
                    onClick={() => setPayAmount(remaining.toFixed(2))}
                    className="text-xs px-2 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800/50 hover:bg-blue-100 transition-colors font-semibold flex-shrink-0 whitespace-nowrap"
                    title="Fill remaining amount"
                  >↙ All</button>
                )}
                <button
                  onClick={addPayment}
                  className="px-3 py-1.5 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs font-bold rounded-lg hover:bg-gray-700 dark:hover:bg-gray-300 transition-colors flex-shrink-0"
                >Add</button>
              </div>

              {/* Payment lines */}
              {paymentLines.length > 0 && (
                <div className="space-y-1 bg-gray-50 dark:bg-gray-800/40 rounded-lg p-2">
                  {paymentLines.map((p, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-gray-600 dark:text-gray-400 capitalize flex items-center gap-1">
                        <span>{PAYMENT_TABS.find(t => t.method === p.method)?.icon}</span>
                        {p.method === 'store_credit' ? 'Store Credit' : p.method.replace(/_/g, ' ')}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-gray-900 dark:text-white tabular-nums">{currency} {parseFloat(p.amount).toFixed(2)}</span>
                        <button onClick={() => removePayment(i)} className="text-gray-300 hover:text-red-500 transition-colors" aria-label="Remove payment">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    </div>
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
              <div className="px-3 py-2.5 space-y-1.5 flex-shrink-0 border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">

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
                  disabled={createMut.isPending || cart.length === 0 || !locationId || Math.abs(remaining) > 0.01}
                  className="w-full flex items-center justify-between gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-xl transition-colors shadow-md shadow-emerald-600/20 active:scale-[0.98]"
                >
                  <span className="text-sm">{createMut.isPending ? '⏳ Processing…' : '✓ Complete Sale'}</span>
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
                      className="w-full px-2.5 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                )}

                {/* Credit Sale — only shown when there's an unpaid balance */}
                {remaining > 0.01 && (
                  <button
                    id="pos-credit-sale"
                    onClick={completeCreditSale}
                    disabled={createMut.isPending || cart.length === 0 || !locationId || !selectedCustomer}
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
