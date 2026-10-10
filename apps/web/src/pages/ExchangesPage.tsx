import { useState, useEffect } from 'react';
import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { useCurrency } from '../lib/useCurrency.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../components/Pagination.js';
import { PAYMENT_METHOD_META, type PaymentMethodCode } from '../lib/paymentMethods.js';

// How the customer pays what they owe at the counter (owner decision 2a).
const PAY_METHODS: PaymentMethodCode[] = ['cash', 'bank', 'mobile', 'store_credit', 'loyalty_points'];

type Role = string;
interface ExchangesPageProps { userRole?: Role; userPermissions?: string[]; }

interface ExchangeItem { id: string; bookId: number; bookTitle: string; quantity: number; unitPrice: number; totalPrice: number; itemType?: string; condition?: string; }
interface Exchange {
  id: string; exchangeReference: string;
  status: string; lifecycleStatus?: string;
  settlementType: string;
  totalIncomingValue: number; totalOutgoingValue: number; netBalance: number;
  currency: string; createdAt: string;
  incomingItems?: ExchangeItem[]; outgoingItems?: ExchangeItem[];
  /** Completed today: a Manager or Admin can still void it. */
  voidable?: boolean;
  voidReason?: string | null;
  refundMethod?: 'store_credit' | 'cash' | null;
  outstandingAmount?: number;
  dueDate?: string | null;
  settlementStatus?: string;
}
interface ExchangeListResponse { items: Exchange[]; total: number; page: number; totalPages: number; }
interface BookResult { id: number; title: string; isbn: string; defaultPrice: number | null; branchPrice: number | null; availability?: { locationId: number; locationName: string | null; onHand: number; reserved: number; available: number; } | null; }

const canCreate = (r?: Role, perms?: string[]) =>
  (perms && perms.includes('CREATE_SALE')) ||
  ['Sales', 'Manager', 'Admin', 'Super_Admin'].includes(r ?? '');

type Tab = 'list' | 'new';

// Only a Manager or Admin voids an exchange, on its day (owner decision 5a).
const canVoid = (r?: Role) => ['Manager', 'Admin'].includes(r ?? '');

export default function ExchangesPage({ userRole, userPermissions = [] }: ExchangesPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const currency = useCurrency();
  const branchId = getCurrentBranchId() ?? 1;
  const [tab, setTab] = useState<Tab>('list');

  // List state
  const [listPage, setListPage] = useState(1);
  const [listPageSize, setListPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Quick Exchange state
  const [locationId, setLocationId] = useState<number | ''>('');
  const [bookSearch, setBookSearch] = useState('');
  const [incomingItems, setIncomingItems] = useState<Array<{ bookId: number; bookTitle: string; quantity: number; unitPrice: number; condition: 'resellable' | 'damaged' }>>([]);
  const [outgoingItems, setOutgoingItems] = useState<Array<{ bookId: number; bookTitle: string; quantity: number; unitPrice: number }>>([]);
  const [addingTo, setAddingTo] = useState<'incoming' | 'outgoing'>('incoming');
  // Settling the difference: the customer pays at the counter (or leaves the rest on credit), or the store refunds.
  const [payMethod, setPayMethod] = useState<PaymentMethodCode>('cash');
  const [payAmount, setPayAmount] = useState('');
  const [allowCredit, setAllowCredit] = useState(false);
  const [refundMethod, setRefundMethod] = useState<'store_credit' | 'cash'>('store_credit');

  // Quick Catalog Register modal (Non-Destructive Catalog Search & Virtual
  // Receiving) — lets Sales register a catalog-only entry for a book that's
  // never been in the Catalog, without leaving the Exchange screen. Creates
  // metadata only; never touches inventory (see POST /books/quick-register).
  const [quickRegisterOpen, setQuickRegisterOpen] = useState(false);
  const [qrIsbn, setQrIsbn] = useState('');
  const [qrTitle, setQrTitle] = useState('');
  const [qrAuthor, setQrAuthor] = useState('');
  const [qrPrice, setQrPrice] = useState('');

  // Customer association state
  interface Customer { id: number; customerCode: string; fullName: string; }
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  // userPermissions available for future fine-grained checks
  void userPermissions;

  // Queries
  const { data: listData, isLoading } = useQuery<ExchangeListResponse>({
    queryKey: ['exchanges-list', listPage, listPageSize, branchId],
    queryFn: () => api.get(`/exchanges?branchId=${branchId}&page=${listPage}&pageSize=${listPageSize}`),
    enabled: tab === 'list',
  });

  const { data: locData } = useQuery<{ items: Array<{ id: number; name: string; isDefaultFulfillment: boolean }> }>({
    queryKey: ['exc-locations', branchId],
    queryFn: () => api.get(`/branches/${branchId}/locations?pageSize=50`),
  });

  // Bug fix: locationId used to stay '' until the staff manually picked one
  // from the dropdown below, so book search's availability lookup (which
  // requires a locationId) silently never ran — stock never showed. Default
  // it to the branch's default-fulfillment location (or first location) as
  // soon as locations load, same fallback Orders' New Order screen uses; the
  // dropdown still lets staff override it before completing the exchange.
  useEffect(() => {
    if (locationId !== '' || !locData?.items?.length) return;
    const def = locData.items.find(l => l.isDefaultFulfillment) ?? locData.items[0];
    if (def) setLocationId(def.id);
  }, [locData]);

  const { data: bookResults } = useQuery<{ items: BookResult[] }>({
    queryKey: ['exc-books', bookSearch, locationId, branchId],
    queryFn: () => api.get(`/books/with-availability?q=${encodeURIComponent(bookSearch)}&pageSize=8&branchId=${branchId}${locationId ? `&locationId=${locationId}` : ''}`),
    enabled: bookSearch.length > 1,
  });

  const { data: customerResults } = useQuery<{ items: Array<{ id: number; customerCode: string; fullName: string }> }>({
    queryKey: ['exc-customers', customerSearch],
    queryFn: () => api.get(`/customers?q=${encodeURIComponent(customerSearch)}&pageSize=5`),
    enabled: customerSearch.length > 1,
  });

  const quickRegisterMut = useMutation({
    mutationFn: (body: unknown) => api.post<{ id: number; title: string; isbn: string; defaultPrice: number | null }>('/books/quick-register', body),
    onSuccess: (book) => {
      showToast(`"${book.title}" registered in the catalog`, 'success');
      addBook({ id: book.id, title: book.title, isbn: book.isbn, defaultPrice: book.defaultPrice, branchPrice: null, availability: null });
      setQuickRegisterOpen(false);
      setQrIsbn(''); setQrTitle(''); setQrAuthor(''); setQrPrice('');
      // The new book is now searchable everywhere else too.
      qc.invalidateQueries({ queryKey: ['exc-books'] });
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<Exchange>('/exchanges', body),
    onSuccess: (e) => {
      showToast(`Exchange ${e.exchangeReference} completed`, 'success');
      setIncomingItems([]); setOutgoingItems([]); setBookSearch('');
      setSelectedCustomer(null); setCustomerSearch('');
      setPayAmount(''); setAllowCredit(false); setRefundMethod('store_credit');
      qc.invalidateQueries({ queryKey: ['exchanges-list'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-low-stock'] });
      setTab('list');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const voidMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post<Exchange>(`/exchanges/${id}/void`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exchanges-list'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-low-stock'] });
      showToast('Exchange voided', 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  function voidExchange(id: string) {
    const reason = prompt('Why is this exchange being voided?')?.trim();
    if (reason) voidMut.mutate({ id, reason });
  }

  function addBook(book: BookResult) {
    const price = book.branchPrice ?? book.defaultPrice ?? 0;
    const list = addingTo === 'incoming' ? incomingItems : outgoingItems;
    const existing = list.find(i => i.bookId === book.id);
    if (existing) {
      if (addingTo === 'incoming') setIncomingItems(items => items.map(i => i.bookId === book.id ? { ...i, quantity: i.quantity + 1 } : i));
      else setOutgoingItems(items => items.map(i => i.bookId === book.id ? { ...i, quantity: i.quantity + 1 } : i));
    } else {
      if (addingTo === 'incoming') setIncomingItems(items => [...items, { bookId: book.id, bookTitle: book.title, quantity: 1, unitPrice: price, condition: 'resellable' }]);
      else setOutgoingItems(items => [...items, { bookId: book.id, bookTitle: book.title, quantity: 1, unitPrice: price }]);
    }
    setBookSearch('');
  }

  const incomingTotal = incomingItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const outgoingTotal = outgoingItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const netBalance = outgoingTotal - incomingTotal;
  const settlementType = Math.abs(netBalance) < 0.01 ? 'Even' : netBalance > 0 ? 'Customer Pays' : 'Store Refunds';

  function submitExchange() {
    if (incomingItems.length === 0 && outgoingItems.length === 0) { showToast('Add at least one item', 'error'); return; }
    if (!locationId) { showToast('Select a location — every exchange moves physical stock', 'error'); return; }
    // Acquisition Allowance Capture / Valuation Integrity: an incoming item's
    // unit price IS the Customer Allowance Value — it becomes that unit's
    // cost basis in inventory once the exchange completes. A zero/blank
    // allowance would receive stock with no real cost, corrupting COGS for
    // every future sale of that book — block it client-side too (the backend
    // enforces this regardless).
    const unvalued = incomingItems.find(i => !(i.unitPrice > 0));
    if (unvalued) {
      showToast(`Enter a trade-in allowance for "${unvalued.bookTitle}" — it can't be zero`, 'error');
      return;
    }
    const paid = netBalance > 0.01 ? (payAmount === '' ? netBalance : parseFloat(payAmount) || 0) : 0;
    if (netBalance > 0.01 && paid < netBalance - 0.01 && !allowCredit) {
      showToast('Take the full difference, or leave the rest on credit', 'error');
      return;
    }
    if ((allowCredit && netBalance > 0.01 && paid < netBalance - 0.01) || (netBalance < -0.01 && refundMethod === 'store_credit')
      || ((payMethod === 'store_credit' || payMethod === 'loyalty_points') && paid > 0)) {
      if (!selectedCustomer) { showToast('Select a customer: credit, store credit and points belong to a customer', 'error'); return; }
    }
    createMut.mutate({
      locationId,
      customerId: selectedCustomer?.id ?? undefined,
      incomingItems: incomingItems.map(i => ({ bookId: i.bookId, quantity: i.quantity, unitPrice: i.unitPrice, condition: i.condition })),
      outgoingItems: outgoingItems.map(i => ({ bookId: i.bookId, quantity: i.quantity })),
      payments: paid > 0 ? [{ method: payMethod, amount: Number(paid.toFixed(2)) }] : [],
      allowCredit: allowCredit && paid < netBalance - 0.01,
      refundMethod,
    });
  }

  const locations = locData?.items ?? [];

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex-shrink-0">
        {/* Layout standardization: Operation (Quick Exchange) tab button shown
            before History (Exchanges) — visual order only. Default active tab
            stays 'list' so Dashboard drill-downs and normal review workflows
            are unaffected. */}
        {([
          { key: 'new', label: '⚡ Quick Exchange' },
          { key: 'list', label: '🔁 Exchanges' },
        ] as { key: Tab; label: string }[]).map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-sm font-medium transition-colors ${tab === key ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── List ── */}
      {tab === 'list' && (
        <div className="flex-1 overflow-auto p-4 space-y-3">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
            {isLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : (
              <table className="w-full text-sm min-w-[800px]">
                <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <tr>{['Reference','Incoming','Outgoing','Difference','Outstanding','Settlement Status','Date','Actions'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {(listData?.items ?? []).map(exc => (
                    <React.Fragment key={exc.id}>
                      <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer" onClick={() => setExpandedId(expandedId === exc.id ? null : exc.id)}>
                        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{exc.exchangeReference}</td>
                        <td className="px-4 py-3 text-sm text-gray-900 dark:text-white whitespace-nowrap">{currency} {Number(exc.totalIncomingValue).toFixed(2)}</td>
                        <td className="px-4 py-3 text-sm text-gray-900 dark:text-white whitespace-nowrap">{currency} {Number(exc.totalOutgoingValue).toFixed(2)}</td>
                        <td className="px-4 py-3 text-sm font-medium whitespace-nowrap">
                          <div style={{ color: Number(exc.netBalance) > 0 ? '#d97706' : Number(exc.netBalance) < 0 ? '#2563eb' : '#6b7280' }}>
                            {Number(exc.netBalance) > 0 ? '+' : ''}{Number(exc.netBalance).toFixed(2)}
                          </div>
                          <div className="text-[10px] text-gray-400 font-medium">
                            {exc.settlementType === 'Even' ? 'Even Exchange' : exc.settlementType === 'Customer_Pays' ? 'Customer Pays' : 'Store Refunds'}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm font-semibold text-gray-900 dark:text-white tabular-nums whitespace-nowrap">
                          {exc.outstandingAmount != null && exc.outstandingAmount > 0.01 ? `${currency} ${Number(exc.outstandingAmount).toFixed(2)}` : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            exc.settlementStatus === 'Settled'
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : exc.settlementStatus === 'PartiallyPaid'
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                : exc.settlementStatus === 'Overdue'
                                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                  : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                          }`}>
                            {exc.settlementStatus ?? 'Pending'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(exc.createdAt).toLocaleString()}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 flex-wrap">
                            {exc.voidable && canVoid(userRole) && (
                              <button onClick={e => { e.stopPropagation(); voidExchange(exc.id); }} disabled={voidMut.isPending}
                                className="text-xs px-2 py-0.5 rounded transition-colors text-red-600 hover:bg-red-50 dark:hover:bg-red-950">
                                Void
                              </button>
                            )}
                            {exc.status === 'Cancelled' && <span className="text-xs text-gray-400">{exc.voidReason ? `Voided: ${exc.voidReason}` : 'Cancelled'}</span>}
                            {exc.status === 'Completed' && (
                              <button onClick={e => { e.stopPropagation(); window.print(); }}
                                className="text-xs px-2 py-0.5 rounded transition-colors text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
                                🖨 Print
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expandedId === exc.id && (
                        <tr key={`${exc.id}-detail`}>
                          <td colSpan={8} className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50">
                            <ExchangeDetailLoader exchangeId={exc.id} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            )}
            {(!listData?.items || listData.items.length === 0) && !isLoading && <p className="text-center text-gray-400 text-sm py-8">No exchanges found</p>}
            {listData && (
              <Pagination
                page={listPage} pageSize={listPageSize} total={listData.total} totalPages={listData.totalPages}
                onPageChange={setListPage} onPageSizeChange={makePageSizeHandler(setListPage, setListPageSize)}
                itemLabel="exchange"
              />
            )}
          </div>
        </div>
      )}

      {/* ── New Exchange ── */}
      {tab === 'new' && canCreate(userRole, userPermissions) && (
        <div className="flex-1 overflow-auto p-4 pb-6 max-w-3xl mx-auto w-full space-y-4">
          {/* Location — required: every exchange moves physical stock, and
              without a location neither the availability check nor the
              inventory update can run. */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Location <span className="text-red-500">*</span></h3>
            <select required value={locationId} onChange={e => setLocationId(Number(e.target.value) || '')}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">Select location...</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
            </select>
          </div>

          {/* Customer — needed for credit, store credit and loyalty points. */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              Customer <span className="text-gray-400 font-normal">(needed for credit, store credit and points)</span>
            </h3>
            {selectedCustomer ? (
              <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-950/30 rounded-lg px-3 py-2">
                <span className="text-sm text-blue-700 dark:text-blue-300">{selectedCustomer.fullName} <span className="text-xs text-blue-500">({selectedCustomer.customerCode})</span></span>
                <button onClick={() => { setSelectedCustomer(null); setCustomerSearch(''); }} className="text-gray-400 hover:text-red-500 text-sm">×</button>
              </div>
            ) : (
              <div className="relative">
                <input value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} placeholder="Search customer by name or code..."
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                {(customerResults?.items ?? []).length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10">
                    {(customerResults?.items ?? []).map(c => (
                      <button key={c.id} onClick={() => { setSelectedCustomer(c); setCustomerSearch(''); }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors border-b border-gray-100 dark:border-gray-800 last:border-0">
                        <span className="font-medium text-gray-900 dark:text-white">{c.fullName}</span>
                        <span className="text-gray-500 dark:text-gray-400 ml-2 text-xs">{c.customerCode}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Book search */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
            <div className="flex gap-2">
              <button onClick={() => setAddingTo('incoming')} className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${addingTo === 'incoming' ? 'bg-green-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}>📥 Add Incoming</button>
              <button onClick={() => setAddingTo('outgoing')} className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${addingTo === 'outgoing' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}>📤 Add Outgoing</button>
            </div>
            <div className="relative">
              <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder={`Search books to add as ${addingTo}...`}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              {(bookResults?.items ?? []).length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
                  {(bookResults?.items ?? []).map(b => (
                    <button key={b.id} onClick={() => addBook(b)} className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors border-b border-gray-100 dark:border-gray-800 last:border-0">
                      <p className="font-medium text-gray-900 dark:text-white truncate">{b.title}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{b.isbn} · {currency} {(b.branchPrice ?? b.defaultPrice ?? 0).toFixed(2)}</p>
                      {b.availability != null && (
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {b.availability.locationName && <span className="text-xs text-gray-400">📍 {b.availability.locationName}</span>}
                          <span className={`text-xs font-medium ${b.availability.available === 0 ? 'text-red-600 dark:text-red-400' : b.availability.available <= 3 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                            {b.availability.available === 0 ? '⚠ Out of stock' : `✓ ${b.availability.available} available`}
                          </span>
                          {b.availability.reserved > 0 && <span className="text-xs text-orange-500 dark:text-orange-400">🔒 {b.availability.reserved} reserved</span>}
                          <span className="text-xs text-gray-400">On hand: {b.availability.onHand}</span>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {/* Non-Destructive Catalog Search & Virtual Receiving: the
                  Exchange screen must be able to accept a book that's never
                  been in the Catalog at all — offer Quick Catalog Register
                  the moment a search for an incoming trade-in comes up
                  empty, instead of forcing staff to leave this screen. */}
              {addingTo === 'incoming' && bookSearch.length > 1 && (bookResults?.items ?? []).length === 0 && (
                <button
                  onClick={() => { setQrTitle(bookSearch); setQuickRegisterOpen(true); }}
                  className="mt-2 w-full text-left px-3 py-2 text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/30 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/40 transition-colors"
                >
                  + Can't find it? Quick-register "{bookSearch}" as a new catalog entry
                </button>
              )}
            </div>
          </div>

          {/* Items */}
          <div className="grid grid-cols-2 gap-4">
            {/* Incoming */}
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-green-200 dark:border-green-800 p-4 space-y-2">
              <h3 className="text-sm font-semibold text-green-700 dark:text-green-400">📥 Incoming (Customer Gives)</h3>
              {incomingItems.length === 0 ? <p className="text-xs text-gray-400">No items yet</p> : (
                <>
                  <div className="flex items-center gap-2 text-[10px] text-gray-400 uppercase tracking-wide">
                    <span className="flex-1">Book</span>
                    <span className="w-12 text-center">Qty</span>
                    <span className="w-20 text-center">Allowance</span>
                    <span className="w-24 text-center">Condition</span>
                    <span className="w-4" />
                  </div>
                  {incomingItems.map(item => (
                    <div key={item.bookId} className="flex items-center gap-2 text-xs">
                      <span className="flex-1 min-w-0 truncate text-gray-900 dark:text-white">{item.bookTitle}</span>
                      <input type="number" min="1" value={item.quantity} onChange={e => setIncomingItems(items => items.map(i => i.bookId === item.bookId ? { ...i, quantity: parseInt(e.target.value) || 1 } : i))} className="w-12 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                      <input
                        type="number" min="0.01" step="0.01" value={item.unitPrice}
                        title="Customer Allowance Value — the trade-in credit granted for this book; becomes its cost basis in inventory"
                        onChange={e => setIncomingItems(items => items.map(i => i.bookId === item.bookId ? { ...i, unitPrice: parseFloat(e.target.value) || 0 } : i))}
                        className={`w-20 px-1 py-0.5 border rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white ${item.unitPrice > 0 ? 'border-gray-300 dark:border-gray-600' : 'border-red-400 dark:border-red-600'}`}
                      />
                      <select aria-label={`Condition of ${item.bookTitle}`} value={item.condition}
                        onChange={e => setIncomingItems(items => items.map(i => i.bookId === item.bookId ? { ...i, condition: e.target.value as 'resellable' | 'damaged' } : i))}
                        className="w-24 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
                        <option value="resellable">Resellable</option>
                        <option value="damaged">Damaged</option>
                      </select>
                      <button onClick={() => setIncomingItems(items => items.filter(i => i.bookId !== item.bookId))} className="text-red-500 hover:text-red-700">×</button>
                    </div>
                  ))}
                </>
              )}
              <div className="text-xs font-semibold text-green-700 dark:text-green-400 pt-1 border-t border-green-100 dark:border-green-900">Total: {currency} {incomingTotal.toFixed(2)}</div>
            </div>
            {/* Outgoing */}
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-blue-200 dark:border-blue-800 p-4 space-y-2">
              <h3 className="text-sm font-semibold text-blue-700 dark:text-blue-400">📤 Outgoing (Customer Takes)</h3>
              {outgoingItems.length === 0 ? <p className="text-xs text-gray-400">No items yet</p> : outgoingItems.map(item => (
                <div key={item.bookId} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 min-w-0 truncate text-gray-900 dark:text-white">{item.bookTitle}</span>
                  <input type="number" min="1" value={item.quantity} onChange={e => setOutgoingItems(items => items.map(i => i.bookId === item.bookId ? { ...i, quantity: parseInt(e.target.value) || 1 } : i))} className="w-12 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                  <span className="w-20 text-right text-gray-700 dark:text-gray-300" title="Catalog price">{currency} {item.unitPrice.toFixed(2)}</span>
                  <button onClick={() => setOutgoingItems(items => items.filter(i => i.bookId !== item.bookId))} className="text-red-500 hover:text-red-700">×</button>
                </div>
              ))}
              <div className="text-xs font-semibold text-blue-700 dark:text-blue-400 pt-1 border-t border-blue-100 dark:border-blue-900">Total: {currency} {outgoingTotal.toFixed(2)}</div>
            </div>
          </div>

          {/* Summary */}
          {(incomingItems.length > 0 || outgoingItems.length > 0) && (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
              <div className="flex justify-between text-sm"><span className="text-gray-500 dark:text-gray-400">Net Balance</span><span className={`font-semibold ${Math.abs(netBalance) < 0.01 ? 'text-gray-600 dark:text-gray-400' : netBalance > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400'}`}>{currency} {netBalance.toFixed(2)}</span></div>
              <div className="flex justify-between text-sm"><span className="text-gray-500 dark:text-gray-400">Settlement</span><span className="font-medium text-gray-900 dark:text-white">{settlementType}</span></div>
              {netBalance > 0.01 && (
                <div className="space-y-2 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
                  <div className="flex gap-2 items-center">
                    <select aria-label="Payment method" value={payMethod} onChange={e => setPayMethod(e.target.value as PaymentMethodCode)}
                      className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
                      {PAY_METHODS.map(m => <option key={m} value={m}>{PAYMENT_METHOD_META[m].icon} {PAYMENT_METHOD_META[m].label}</option>)}
                    </select>
                    <input aria-label="Amount paid" type="number" min="0" step="0.01" value={payAmount} placeholder={netBalance.toFixed(2)}
                      onChange={e => setPayAmount(e.target.value)}
                      className="w-28 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-white" />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                    <input type="checkbox" checked={allowCredit} onChange={e => setAllowCredit(e.target.checked)} />
                    Leave what is not paid on credit (a receivable for the customer)
                  </label>
                </div>
              )}
              {netBalance < -0.01 && (
                <div className="flex gap-2 items-center bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 text-sm">
                  <span className="text-gray-600 dark:text-gray-400">Give back {currency} {Math.abs(netBalance).toFixed(2)} as</span>
                  <select aria-label="Refund method" value={refundMethod} onChange={e => setRefundMethod(e.target.value as 'store_credit' | 'cash')}
                    className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
                    <option value="store_credit">🎁 Store Credit</option>
                    <option value="cash">💵 Cash</option>
                  </select>
                </div>
              )}
              <button onClick={submitExchange} disabled={createMut.isPending}
                className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm mt-2">
                {createMut.isPending ? 'Processing...' : 'Complete Exchange'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Quick Catalog Register modal ──
          Non-Destructive Catalog Search & Virtual Receiving: registers a
          catalog-only entry (ISBN/Barcode, Title, Author, Base List Price)
          without leaving the Exchange screen. This creates catalog metadata
          only — it never increments stock; the incoming exchange item still
          has to be given a Customer Allowance Value and completed like any
          other trade-in for inventory to actually move. */}
      {quickRegisterOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setQuickRegisterOpen(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-sm p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Quick Catalog Register</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">Registers this book in the Catalog so it can be searched and exchanged — it does not add any stock by itself.</p>
            <div className="space-y-2">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">ISBN / Barcode</label>
                <input value={qrIsbn} onChange={e => setQrIsbn(e.target.value)} placeholder="Optional"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">Title <span className="text-red-500">*</span></label>
                <input value={qrTitle} onChange={e => setQrTitle(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">Author</label>
                <input value={qrAuthor} onChange={e => setQrAuthor(e.target.value)} placeholder="Optional"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500" />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">Base List Price</label>
                <input type="number" min="0" step="0.01" value={qrPrice} onChange={e => setQrPrice(e.target.value)} placeholder="Optional"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500" />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setQuickRegisterOpen(false)} className="flex-1 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Cancel</button>
              <button
                onClick={() => {
                  if (!qrTitle.trim()) { showToast('Title is required', 'error'); return; }
                  quickRegisterMut.mutate({
                    isbn: qrIsbn.trim() || undefined,
                    title: qrTitle.trim(),
                    author: qrAuthor.trim() || undefined,
                    defaultPrice: qrPrice ? parseFloat(qrPrice) : undefined,
                  });
                }}
                disabled={quickRegisterMut.isPending || !qrTitle.trim()}
                className="flex-1 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold transition-colors"
              >
                {quickRegisterMut.isPending ? 'Registering...' : 'Register & Add'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function ExchangeDetailLoader({ exchangeId }: { exchangeId: string }) {
  const currency = useCurrency();
  const { data } = useQuery<{
    incomingItems?: ExchangeItem[];
    outgoingItems?: ExchangeItem[];
    outstandingAmount?: number;
    dueDate?: string | null;
    settlementStatus?: string;
    netBalance?: string | number;
    settlementType?: string;
  }>({
    queryKey: ['exchange-detail', exchangeId],
    queryFn: () => api.get(`/exchanges/${exchangeId}`),
  });
  if (!data) return <p className="text-xs text-gray-400">Loading...</p>;
  return (
    <div className="grid grid-cols-3 gap-4 text-xs">
      <div>
        <p className="font-semibold text-green-700 dark:text-green-400 mb-1">Incoming Items</p>
        {(data.incomingItems ?? []).map((i, idx) => <p key={idx} className="text-gray-700 dark:text-gray-300">{i.bookTitle} × {i.quantity} @ {currency} {Number(i.unitPrice).toFixed(2)}</p>)}
        {(data.incomingItems ?? []).length === 0 && <p className="text-gray-400 italic">No incoming items</p>}
      </div>
      <div>
        <p className="font-semibold text-blue-700 dark:text-blue-400 mb-1">Outgoing Items</p>
        {(data.outgoingItems ?? []).map((i, idx) => <p key={idx} className="text-gray-700 dark:text-gray-300">{i.bookTitle} × {i.quantity} @ {currency} {Number(i.unitPrice).toFixed(2)}</p>)}
        {(data.outgoingItems ?? []).length === 0 && <p className="text-gray-400 italic">No outgoing items</p>}
      </div>
      <div className="border-l border-gray-200 dark:border-gray-700 pl-4 space-y-1.5">
        <p className="font-semibold text-purple-700 dark:text-purple-400 mb-1">Settlement Details</p>
        <p className="text-gray-600 dark:text-gray-400">Difference: <span className="font-medium text-gray-900 dark:text-white">{currency} {Number(data.netBalance ?? 0).toFixed(2)} ({data.settlementType?.replace('_', ' ')})</span></p>
        <p className="text-gray-600 dark:text-gray-400">Status: <span className="font-medium text-gray-900 dark:text-white">{data.settlementStatus ?? 'Settled'}</span></p>
        {data.outstandingAmount != null && data.outstandingAmount > 0.01 && (
          <p className="text-gray-600 dark:text-gray-400">Outstanding: <span className="font-semibold text-amber-600 dark:text-amber-400">{currency} {Number(data.outstandingAmount).toFixed(2)}</span></p>
        )}
        {data.dueDate && (
          <p className="text-gray-600 dark:text-gray-400">Due Date: <span className="font-medium text-gray-900 dark:text-white">{data.dueDate}</span></p>
        )}
      </div>
    </div>
  );
}
