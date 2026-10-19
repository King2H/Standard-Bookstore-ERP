import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { useCurrency } from '../lib/useCurrency.js';
import { type PaymentMethodCode } from '../lib/paymentMethods.js';
import PaymentMethodTabs from '../components/PaymentMethodTabs.js';
import BankAccountSelect from '../components/BankAccountSelect.js';
import PaymentProofFields from '../components/PaymentProofFields.js';
import { useBranchBankAccounts } from '../features/bankAccounts/queries.js';
import { EMPTY_PROOF, proofError, proofFields, type PaymentProof } from '../lib/paymentProof.js';

// The New Order form, as it was on the legacy Orders page. Orders part 1
// (#23) moved the list and its actions to features/orders; part 2 moves
// this form there too and removes this file.

type Role = string;
interface Order { id: string; orderNumber: string; saleType?: 'cash_sale' | 'credit_sale'; }
interface Customer { id: number; customerCode: string; fullName: string; }
interface BookResult { id: number; title: string; isbn: string; defaultPrice: number | null; branchPrice: number | null; stockQuantity?: number | null; availability?: { locationId: number; locationName: string | null; onHand: number; reserved: number; available: number; } | null; }

const canCreate = (r?: Role, perms?: string[]) =>
  (perms && perms.includes('CREATE_SALE')) ||
  ['Sales', 'Manager', 'Admin', 'Super_Admin'].includes(r ?? '');

export default function NewOrderLegacy({ userRole, userPermissions = [], onCreated }: {
  userRole?: Role; userPermissions?: string[]; onCreated: () => void;
}) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const currency = useCurrency();
  const branchId = getCurrentBranchId() ?? 1;

  // New order state
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [saleType, setSaleType] = useState<'cash_sale' | 'credit_sale'>('cash_sale');
  // Payment Method at Creation: for a cash sale, captured right here instead
  // of a separate post-creation "Confirm (set payment method)" step — Create
  // Order now creates AND confirms (see createMut) in one action.
  const [orderPaymentMethod, setOrderPaymentMethod] = useState<PaymentMethodCode>('cash');
  const [orderProof, setOrderProof] = useState<PaymentProof>(EMPTY_PROOF);
  const [orderBankAccountId, setOrderBankAccountId] = useState<number | null>(null);
  // Due Date at Creation: same treatment for credit sales — captured here
  // instead of a separate post-creation "Confirm (set due date)" step, so
  // Create Order creates AND confirms in one action for credit sales too.
  const [orderDueDate, setOrderDueDate] = useState('');
  const [channel, setChannel] = useState<'in_store' | 'phone' | 'online'>('in_store');
  const [bookSearch, setBookSearch] = useState('');
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [orderItems, setOrderItems] = useState<Array<{ bookId: number; bookTitle: string; quantity: number; unitPrice: number; discountPct: number; discountType: string; discountMode: string; availableStock: number | null; }>>([]);

  const { data: customerResults } = useQuery<{ items: Customer[] }>({
    queryKey: ['order-customers', customerSearch],
    queryFn: () => api.get(`/customers?q=${encodeURIComponent(customerSearch)}&pageSize=5`),
    enabled: customerSearch.length > 1,
  });

  // Fetch branch locations so we can pass locationId to book search for stock availability
  const { data: branchLocations } = useQuery<{ items: Array<{ id: number; name: string; isDefaultFulfillment: boolean }> }>({
    queryKey: ['branch-locations-orders', branchId],
    queryFn: () => api.get(`/branches/${branchId}/locations`),
    enabled: branchId > 0,
    staleTime: 60_000,
  });
  // Auto-select the default fulfillment location when locations load
  const effectiveLocationId = selectedLocationId ?? branchLocations?.items?.find(l => l.isDefaultFulfillment)?.id ?? branchLocations?.items?.[0]?.id ?? null;

  const { data: bookResults } = useQuery<{ items: BookResult[] }>({
    // Bug fix: this used to key/query off `selectedLocationId` alone, which is
    // only ever set by the Fulfillment Location dropdown — a dropdown that
    // itself only renders when a branch has more than one location (see
    // below). Single-location branches (the common case) never set it, so
    // stock availability silently never showed in book search. `effectiveLocationId`
    // already carries the same default-fulfillment/first-location fallback the
    // order submission itself uses — use that here too.
    queryKey: ['order-books', bookSearch, branchId, effectiveLocationId],
    queryFn: () => api.get(`/books/with-availability?q=${encodeURIComponent(bookSearch)}&pageSize=8&branchId=${branchId}${effectiveLocationId ? `&locationId=${effectiveLocationId}` : ''}`),
    enabled: bookSearch.length > 1,
  });

  // With Bank Accounts on, a bank payment names the account it went to (#21).
  const { accounts: bankAccounts, required: bankAccountRequired } = useBranchBankAccounts(
    branchId, orderPaymentMethod === 'bank',
  );

  /** What a cash order's payment still lacks, or null. */
  function cashPaymentProblem(method: string, proof: PaymentProof, bankAccountId: number | null): string | null {
    if (method === 'bank' && bankAccountRequired && !bankAccountId) return 'Select a bank account for bank transfer payments';
    return proofError(method, proof);
  }

  /** The confirm body of a cash order: its method and, for bank and Telebirr, the proof. */
  function cashConfirmBody(method: string, proof: PaymentProof, bankAccountId: number | null) {
    const { payerBank, reference } = proofFields(method, proof);
    return {
      paymentMethod: method,
      ...(payerBank && { payerBank }),
      ...(reference && { transactionReference: reference }),
      ...(method === 'bank' && bankAccountId && { bankAccountId }),
    };
  }

  const createMut = useMutation({
    mutationFn: async (body: { saleType: 'cash_sale' | 'credit_sale'; confirmBody?: object; dueDate?: string; [key: string]: unknown }) => {
      const { confirmBody, dueDate, ...orderBody } = body;
      const order = await api.post<Order>('/orders', orderBody);
      if (body.saleType === 'cash_sale') {
        return api.post<Order>(`/orders/${order.id}/confirm`, confirmBody);
      }
      if (body.saleType === 'credit_sale') {
        return api.post<Order>(`/orders/${order.id}/confirm`, { dueDate });
      }
      return order;
    },
    onSuccess: (o) => {
      const msg = o.saleType === 'cash_sale' ? `Order ${o.orderNumber} created & paid`
        : o.saleType === 'credit_sale' ? `Order ${o.orderNumber} created & confirmed`
        : `Order ${o.orderNumber} created`;
      showToast(msg, 'success');
      setOrderItems([]); setSelectedCustomer(null); setOrderPaymentMethod('cash'); setOrderDueDate('');
      setOrderProof(EMPTY_PROOF); setOrderBankAccountId(null);
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['order-books'] });
      onCreated();
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  function addItem(book: BookResult) {
    const price = book.branchPrice ?? book.defaultPrice ?? 0;
    const availableStock = book.availability?.available ?? null;
    const existing = orderItems.find(i => i.bookId === book.id);
    if (existing) {
      if (availableStock != null && existing.quantity >= availableStock) {
        showToast(`Only ${availableStock} in stock for "${book.title}"`, 'error');
        return;
      }
      setOrderItems(items => items.map(i => i.bookId === book.id ? { ...i, quantity: i.quantity + 1 } : i));
    } else {
      if (availableStock != null && availableStock <= 0) {
        showToast(`"${book.title}" is out of stock`, 'error');
        return;
      }
      setOrderItems(items => [...items, { bookId: book.id, bookTitle: book.title, quantity: 1, unitPrice: price, discountPct: 0, discountType: 'Normal', discountMode: 'Percentage', availableStock }]);
    }
    setBookSearch('');
  }

  function submitOrder() {
    if (orderItems.length === 0) { showToast('Add at least one item', 'error'); return; }
    if (saleType === 'credit_sale' && !selectedCustomer) {
      showToast('Credit sales require a customer', 'error');
      return;
    }
    if (saleType === 'credit_sale' && !orderDueDate) {
      showToast('Credit sales require a due date', 'error');
      return;
    }
    if (saleType === 'cash_sale' && orderPaymentMethod === 'store_credit' && !selectedCustomer) {
      showToast('Store credit payment requires a customer — please select one above', 'error');
      return;
    }
    const paymentProblem = saleType === 'cash_sale' ? cashPaymentProblem(orderPaymentMethod, orderProof, orderBankAccountId) : null;
    if (paymentProblem) { showToast(paymentProblem, 'error'); return; }
    createMut.mutate({
      customerId: selectedCustomer?.id ?? null,
      channel,
      saleType,
      confirmBody: saleType === 'cash_sale' ? cashConfirmBody(orderPaymentMethod, orderProof, orderBankAccountId) : undefined,
      dueDate: saleType === 'credit_sale' ? orderDueDate : undefined,
      locationId: effectiveLocationId ?? undefined,
      items: orderItems.map(i => ({
        bookId: i.bookId,
        quantity: i.quantity,
        discountPct: i.discountMode === 'Percentage' ? i.discountPct : undefined,
        discountAmount: i.discountMode === 'Amount' ? i.discountPct : undefined,
        discountType: i.discountType,
        discountMode: i.discountMode,
      })),
    });
  }

  const subtotal = orderItems.reduce((s, i) => {
    const lineTotal = i.discountMode === 'Percentage'
      ? i.unitPrice * i.quantity * (1 - i.discountPct / 100)
      : Math.max(0, i.unitPrice * i.quantity - i.discountPct);
    return s + lineTotal;
  }, 0);

  if (!canCreate(userRole, userPermissions)) return null;
  return (
    <div className="flex-1 overflow-auto p-4 pb-6 max-w-2xl mx-auto w-full space-y-4">
      {/* Customer */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Customer (optional)</h3>
        {selectedCustomer ? (
          <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-950/30 rounded-lg px-3 py-2">
            <span className="text-sm text-blue-700 dark:text-blue-300">{selectedCustomer.fullName} ({selectedCustomer.customerCode})</span>
            <button onClick={() => setSelectedCustomer(null)} className="text-gray-400 hover:text-red-500 text-sm">×</button>
          </div>
        ) : (
          <div className="relative">
            <input value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} placeholder="Search customer..."
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
            {(customerResults?.items ?? []).length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10">
                {(customerResults?.items ?? []).map(c => (
                  <button key={c.id} onClick={() => { setSelectedCustomer(c); setCustomerSearch(''); }} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    <span className="font-medium text-gray-900 dark:text-white">{c.fullName}</span>
                    <span className="text-gray-500 dark:text-gray-400 ml-2 text-xs">{c.customerCode}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sale Type */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Sale Type</h3>
        <div className="flex gap-2">
          {([['cash_sale', '💵 Cash Sale'], ['credit_sale', '📋 Credit Sale']] as const).map(([v, label]) => (
            <button key={v} onClick={() => setSaleType(v)}
              className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${saleType === v ? (v === 'credit_sale' ? 'bg-amber-600 text-white' : 'bg-green-600 text-white') : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
              {label}
            </button>
          ))}
        </div>
        {saleType === 'credit_sale' && !selectedCustomer && (
          <p className="text-xs text-amber-600 dark:text-amber-400">⚠ Credit sales require a customer — please select one above.</p>
        )}
        {/* Due Date at Creation — credit sales only; captured here instead
            of a separate post-creation confirm step, mirroring the cash
            sale's Payment Method at Creation below. */}
        {saleType === 'credit_sale' && (
          <div className="pt-1 space-y-1">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Due Date</p>
            <input type="date" value={orderDueDate} min={new Date().toISOString().slice(0, 10)} onChange={e => setOrderDueDate(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
          </div>
        )}
        {/* Payment Method at Creation — cash sales only; captured here
            instead of a separate post-creation confirm step. Method set
            matches orders.service.ts's confirm() CASH_PAYMENT_METHODS. */}
        {saleType === 'cash_sale' && (
          <div className="pt-1 space-y-1">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Payment Method</p>
            <PaymentMethodTabs
              methods={['cash', 'bank', 'mobile', 'store_credit']}
              value={orderPaymentMethod}
              onChange={setOrderPaymentMethod}
              columns={4}
            />
            {orderPaymentMethod === 'store_credit' && !selectedCustomer && (
              <p className="text-xs text-amber-600 dark:text-amber-400">⚠ Store credit requires a customer — please select one above.</p>
            )}
            {orderPaymentMethod === 'bank' && bankAccountRequired && (
              <BankAccountSelect accounts={bankAccounts} value={orderBankAccountId} onChange={setOrderBankAccountId} />
            )}
            <PaymentProofFields method={orderPaymentMethod} value={orderProof} onChange={setOrderProof} />
          </div>
        )}
      </div>

      {/* Channel */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Channel</h3>
        <div className="flex gap-2">
          {(['in_store','phone','online'] as const).map(c => (
            <button key={c} onClick={() => setChannel(c)} className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${channel === c ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
              {c.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Location */}
      {branchLocations && branchLocations.items.length > 1 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Fulfillment Location</h3>
          <select
            value={selectedLocationId ?? effectiveLocationId ?? ''}
            onChange={e => setSelectedLocationId(e.target.value ? Number(e.target.value) : null)}
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500"
          >
            {branchLocations.items.map(l => (
              <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>
            ))}
          </select>
        </div>
      )}

      {/* Items */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Items</h3>
        <div className="relative">
          <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="Search books to add..."
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
          {(bookResults?.items ?? []).length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
              {(bookResults?.items ?? []).map(b => (
                <button key={b.id} onClick={() => addItem(b)}
                  disabled={b.availability != null && b.availability.available === 0}
                  className={`w-full text-left px-3 py-2 text-sm transition-colors border-b border-gray-100 dark:border-gray-800 last:border-0 ${b.availability != null && b.availability.available === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-50 dark:hover:bg-blue-950/30'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-gray-900 dark:text-white truncate min-w-0">{b.title}</p>
                    {b.availability != null && (
                      <span className={`text-xs font-semibold shrink-0 px-1.5 py-0.5 rounded-full ${b.availability.available === 0 ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400' : b.availability.available <= 3 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'}`}>
                        {b.availability.available === 0 ? 'Out of stock' : `${b.availability.available} avail`}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{b.isbn} · {currency} {(b.branchPrice ?? b.defaultPrice ?? 0).toFixed(2)}</p>
                  {b.availability != null ? (
                    <p className="text-xs text-gray-400 mt-0.5">
                      📍 {b.availability.locationName ?? 'Location'} · On hand: {b.availability.onHand} · Reserved: {b.availability.reserved} · Available: {b.availability.available}
                    </p>
                  ) : b.stockQuantity != null && (
                    <p className={`text-xs font-medium mt-0.5 ${b.stockQuantity === 0 ? 'text-red-600 dark:text-red-400' : b.stockQuantity <= 3 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                      {b.stockQuantity === 0 ? '⚠ Out of stock' : b.stockQuantity <= 3 ? `⚠ Only ${b.stockQuantity} left` : `✓ ${b.stockQuantity} in stock`}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        {orderItems.length > 0 && (
          <div className="space-y-2">
            {orderItems.map(item => (
              <div key={item.bookId} className="flex items-center gap-3 p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{item.bookTitle}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{currency} {item.unitPrice.toFixed(2)} each</p>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setOrderItems(items => items.map(i => i.bookId === item.bookId ? { ...i, quantity: Math.max(1, i.quantity - 1) } : i))} className="w-6 h-6 rounded-sm bg-gray-200 dark:bg-gray-700 text-sm font-bold">-</button>
                  <span className="w-8 text-center text-sm">{item.quantity}</span>
                  <button
                    onClick={() => {
                      if (item.availableStock != null && item.quantity >= item.availableStock) {
                        showToast(`Only ${item.availableStock} in stock for "${item.bookTitle}"`, 'error');
                        return;
                      }
                      setOrderItems(items => items.map(i => i.bookId === item.bookId ? { ...i, quantity: i.quantity + 1 } : i));
                    }}
                    disabled={item.availableStock != null && item.quantity >= item.availableStock}
                    className="w-6 h-6 rounded-sm bg-gray-200 dark:bg-gray-700 text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                  >+</button>
                  {item.availableStock != null && (
                    <span className="text-[10px] text-gray-400 ml-1">/{item.availableStock} avail</span>
                  )}
                </div>
                {/* Discount controls */}
                <div className="flex items-center gap-1">
                  <select value={item.discountType} onChange={e => setOrderItems(items => items.map(i => i.bookId === item.bookId ? { ...i, discountType: e.target.value } : i))}
                    className="text-xs px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                    {['Normal','Merchant','Special'].map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button onClick={() => setOrderItems(items => items.map(i => i.bookId === item.bookId ? { ...i, discountMode: i.discountMode === 'Percentage' ? 'Amount' : 'Percentage', discountPct: 0 } : i))}
                    className="text-xs px-1.5 py-0.5 rounded-sm bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 font-mono">
                    {item.discountMode === 'Percentage' ? '%' : '$'}
                  </button>
                  <input type="number" min="0" step="0.01" value={item.discountPct}
                    onChange={e => setOrderItems(items => items.map(i => i.bookId === item.bookId ? { ...i, discountPct: Math.max(0, parseFloat(e.target.value) || 0) } : i))}
                    className="w-14 text-xs px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300" />
                </div>
                <span className="text-sm font-medium text-gray-900 dark:text-white w-20 text-right">
                  {currency} {Math.max(0, item.discountMode === 'Percentage'
                    ? item.unitPrice * item.quantity * (1 - item.discountPct / 100)
                    : item.unitPrice * item.quantity - item.discountPct).toFixed(2)}
                </span>
                <button onClick={() => setOrderItems(items => items.filter(i => i.bookId !== item.bookId))} className="text-gray-400 hover:text-red-500 text-sm">×</button>
              </div>
            ))}
            <div className="flex justify-between text-sm font-semibold text-gray-900 dark:text-white pt-2 border-t border-gray-200 dark:border-gray-700">
              <span>Subtotal</span><span>{currency} {subtotal.toFixed(2)}</span>
            </div>
          </div>
        )}
      </div>

      <button onClick={submitOrder} disabled={createMut.isPending || orderItems.length === 0}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm">
        {createMut.isPending ? 'Creating...' : 'Create Order'}
      </button>
    </div>
  );
}
