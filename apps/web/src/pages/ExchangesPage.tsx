import { useState } from 'react';
import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

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
  allowedActions?: string[];
}
interface ExchangeListResponse { items: Exchange[]; total: number; page: number; totalPages: number; }
interface BookResult { id: number; title: string; isbn: string; defaultPrice: number | null; branchPrice: number | null; }

// Lifecycle status colours — covers both legacy and new values
const STATUS_COLORS: Record<string, string> = {
  // Legacy
  Initiated:  'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  Evaluated:  'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  Completed:  'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  Cancelled:  'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  // New lifecycle
  INITIATED:  'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  REVIEWED:   'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  APPROVED:   'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
  SETTLED:    'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  COMPLETED:  'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  CANCELLED:  'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
};

const SETTLEMENT_COLORS: Record<string, string> = {
  Even:          'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  Customer_Pays: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  Store_Refunds: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
};

const ACTION_STYLES: Record<string, string> = {
  review:   'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 hover:bg-blue-200',
  approve:  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300 hover:bg-indigo-200',
  settle:   'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 hover:bg-purple-200',
  complete: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 hover:bg-green-200',
  cancel:   'text-red-600 hover:bg-red-50 dark:hover:bg-red-950',
  print:    'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
};
const ACTION_LABELS: Record<string, string> = {
  review: 'Review', approve: 'Approve', settle: 'Settle',
  complete: 'Complete', cancel: 'Cancel', print: '🖨 Print',
};

const canCreate = (r?: Role, perms?: string[]) =>
  (perms && perms.includes('CREATE_SALE')) ||
  ['Sales', 'Manager', 'Admin', 'Super_Admin'].includes(r ?? '');

// ── Settlement entry type ─────────────────────────────────────────────────────
interface SettlementEntry { entryType: 'cash_payment' | 'cash_refund' | 'item_value_adjustment'; amount: string; method: string; note: string; }

type Tab = 'list' | 'new' | 'initiate';

export default function ExchangesPage({ userRole, userPermissions = [] }: ExchangesPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const branchId = getCurrentBranchId() ?? 1;
  const [tab, setTab] = useState<Tab>('list');

  // List state
  const [listPage, setListPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Settle modal state
  const [settleModal, setSettleModal] = useState<{ id: string; ref: string; netBalance: number } | null>(null);
  const [settlementEntries, setSettlementEntries] = useState<SettlementEntry[]>([
    { entryType: 'cash_payment', amount: '', method: 'cash', note: '' },
  ]);

  // New exchange (legacy single-step) state
  const [locationId, setLocationId] = useState<number | ''>('');
  const [bookSearch, setBookSearch] = useState('');
  const [incomingItems, setIncomingItems] = useState<Array<{ bookId: number; bookTitle: string; quantity: number; unitPrice: number }>>([]);
  const [outgoingItems, setOutgoingItems] = useState<Array<{ bookId: number; bookTitle: string; quantity: number; unitPrice: number }>>([]);
  const [addingTo, setAddingTo] = useState<'incoming' | 'outgoing'>('incoming');

  // Initiate exchange (new lifecycle) state
  const [initBookSearch, setInitBookSearch] = useState('');
  const [initAddingTo, setInitAddingTo] = useState<'returned' | 'new'>('returned');
  const [returnedItems, setReturnedItems] = useState<Array<{ bookId: number; bookTitle: string; quantity: number; unitPrice: number; condition: 'resellable' | 'damaged' }>>([]);
  const [newItems, setNewItems] = useState<Array<{ bookId: number; bookTitle: string; quantity: number; unitPrice: number }>>([]);
  const [initOriginalOrderId, setInitOriginalOrderId] = useState('');
  const [initNotes, setInitNotes] = useState('');

  // Customer association state (shared across both exchange forms)
  interface Customer { id: number; customerCode: string; fullName: string; }
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [initCustomerSearch, setInitCustomerSearch] = useState('');
  const [initSelectedCustomer, setInitSelectedCustomer] = useState<Customer | null>(null);

  // userPermissions available for future fine-grained checks
  void userPermissions;

  // Queries
  const { data: listData, isLoading } = useQuery<ExchangeListResponse>({
    queryKey: ['exchanges-list', listPage, branchId],
    queryFn: () => api.get(`/exchanges?branchId=${branchId}&page=${listPage}&pageSize=20`),
    enabled: tab === 'list',
  });

  const { data: locData } = useQuery<{ items: Array<{ id: number; name: string; isDefaultFulfillment: boolean }> }>({
    queryKey: ['exc-locations', branchId],
    queryFn: () => api.get(`/branches/${branchId}/locations?pageSize=50`),
  });

  const { data: bookResults } = useQuery<{ items: BookResult[] }>({
    queryKey: ['exc-books', bookSearch],
    queryFn: () => api.get(`/books?q=${encodeURIComponent(bookSearch)}&pageSize=8&branchId=${branchId}`),
    enabled: bookSearch.length > 1,
  });

  const { data: initBookResults } = useQuery<{ items: BookResult[] }>({
    queryKey: ['exc-init-books', initBookSearch],
    queryFn: () => api.get(`/books?q=${encodeURIComponent(initBookSearch)}&pageSize=8&branchId=${branchId}`),
    enabled: initBookSearch.length > 1,
  });

  const { data: customerResults } = useQuery<{ items: Array<{ id: number; customerCode: string; fullName: string }> }>({
    queryKey: ['exc-customers', customerSearch],
    queryFn: () => api.get(`/customers?q=${encodeURIComponent(customerSearch)}&pageSize=5`),
    enabled: customerSearch.length > 1,
  });

  const { data: initCustomerResults } = useQuery<{ items: Array<{ id: number; customerCode: string; fullName: string }> }>({
    queryKey: ['exc-init-customers', initCustomerSearch],
    queryFn: () => api.get(`/customers?q=${encodeURIComponent(initCustomerSearch)}&pageSize=5`),
    enabled: initCustomerSearch.length > 1,
  });

  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<Exchange>('/exchanges', body),
    onSuccess: (e) => {
      showToast(`Exchange ${e.exchangeReference} completed`, 'success');
      setIncomingItems([]); setOutgoingItems([]); setBookSearch('');
      setSelectedCustomer(null); setCustomerSearch('');
      qc.invalidateQueries({ queryKey: ['exchanges-list'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-low-stock'] });
      setTab('list');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => api.post<Exchange>(`/exchanges/${id}/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exchanges-list'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-low-stock'] });
      showToast('Exchange cancelled', 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // New lifecycle mutations
  const initiateMut = useMutation({
    mutationFn: (body: unknown) => api.post<Exchange>('/exchanges/initiate', body),
    onSuccess: (e) => {
      showToast(`Exchange ${e.exchangeReference} initiated`, 'success');
      setReturnedItems([]); setNewItems([]); setInitOriginalOrderId(''); setInitNotes('');
      setInitSelectedCustomer(null); setInitCustomerSearch('');
      qc.invalidateQueries({ queryKey: ['exchanges-list'] });
      setTab('list');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const actionMut = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) =>
      api.post<Exchange>(`/exchanges/${id}/${action}`, body ?? {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exchanges-list'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      showToast('Exchange updated', 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const settleMut = useMutation({
    mutationFn: ({ id, entries }: { id: string; entries: SettlementEntry[] }) =>
      api.post<Exchange>(`/exchanges/${id}/settle`, {
        idempotencyKey: `settle-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        entries: entries.map(e => ({
          entryType: e.entryType,
          amount: parseFloat(e.amount) || 0,
          method: e.method,
          note: e.note || undefined,
        })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exchanges-list'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      showToast('Exchange settled', 'success');
      setSettleModal(null);
      setSettlementEntries([{ entryType: 'cash_payment', amount: '', method: 'cash', note: '' }]);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  function addBook(book: BookResult) {
    const price = book.branchPrice ?? book.defaultPrice ?? 0;
    const list = addingTo === 'incoming' ? incomingItems : outgoingItems;
    const setList = addingTo === 'incoming' ? setIncomingItems : setOutgoingItems;
    const existing = list.find(i => i.bookId === book.id);
    if (existing) {
      setList(items => items.map(i => i.bookId === book.id ? { ...i, quantity: i.quantity + 1 } : i));
    } else {
      setList(items => [...items, { bookId: book.id, bookTitle: book.title, quantity: 1, unitPrice: price }]);
    }
    setBookSearch('');
  }

  const incomingTotal = incomingItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const outgoingTotal = outgoingItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const netBalance = outgoingTotal - incomingTotal;
  const settlementType = Math.abs(netBalance) < 0.01 ? 'Even' : netBalance > 0 ? 'Customer Pays' : 'Store Refunds';

  function submitExchange() {
    if (incomingItems.length === 0 && outgoingItems.length === 0) { showToast('Add at least one item', 'error'); return; }
    createMut.mutate({
      locationId: locationId || undefined,
      customerId: selectedCustomer?.id ?? undefined,
      incomingItems: incomingItems.map(i => ({ bookId: i.bookId, quantity: i.quantity, unitPrice: i.unitPrice })),
      outgoingItems: outgoingItems.map(i => ({ bookId: i.bookId, quantity: i.quantity, unitPrice: i.unitPrice })),
    });
  }

  const locations = locData?.items ?? [];

  // Initiate exchange helpers
  function addInitBook(book: BookResult) {
    const price = book.branchPrice ?? book.defaultPrice ?? 0;
    if (initAddingTo === 'returned') {
      const existing = returnedItems.find(i => i.bookId === book.id);
      if (existing) {
        setReturnedItems(items => items.map(i => i.bookId === book.id ? { ...i, quantity: i.quantity + 1 } : i));
      } else {
        setReturnedItems(items => [...items, { bookId: book.id, bookTitle: book.title, quantity: 1, unitPrice: price, condition: 'resellable' }]);
      }
    } else {
      const existing = newItems.find(i => i.bookId === book.id);
      if (existing) {
        setNewItems(items => items.map(i => i.bookId === book.id ? { ...i, quantity: i.quantity + 1 } : i));
      } else {
        setNewItems(items => [...items, { bookId: book.id, bookTitle: book.title, quantity: 1, unitPrice: price }]);
      }
    }
    setInitBookSearch('');
  }

  const returnedTotal = returnedItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const newItemsTotal = newItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const initNetBalance = newItemsTotal - returnedTotal;

  function submitInitiate() {
    if (returnedItems.length === 0 && newItems.length === 0) { showToast('Add at least one item', 'error'); return; }
    initiateMut.mutate({
      originalOrderId: initOriginalOrderId || undefined,
      customerId: initSelectedCustomer?.id ?? undefined,
      notes: initNotes || undefined,
      exchangeItems: [
        ...returnedItems.map(i => ({ bookId: i.bookId, quantity: i.quantity, unitPrice: i.unitPrice, type: 'returned', condition: i.condition })),
        ...newItems.map(i => ({ bookId: i.bookId, quantity: i.quantity, unitPrice: i.unitPrice, type: 'new' })),
      ],
    });
  }

  // Settlement entry helpers
  function addSettlementEntry() {
    setSettlementEntries(prev => [...prev, { entryType: 'cash_payment', amount: '', method: 'cash', note: '' }]);
  }
  function removeSettlementEntry(idx: number) {
    setSettlementEntries(prev => prev.filter((_, i) => i !== idx));
  }
  const settlementTotal = settlementEntries.reduce((s, e) => {
    const amt = parseFloat(e.amount) || 0;
    return e.entryType === 'cash_refund' ? s - amt : s + amt;
  }, 0);

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex-shrink-0">
        {([
          { key: 'list', label: '🔁 Exchanges' },
          { key: 'initiate', label: '+ Initiate Exchange' },
          { key: 'new', label: '⚡ Quick Exchange' },
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
                  <tr>{['Reference','Incoming','Outgoing','Balance','Settlement','Status','Date','Actions'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {(listData?.items ?? []).map(exc => (
                    <React.Fragment key={exc.id}>
                      <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer" onClick={() => setExpandedId(expandedId === exc.id ? null : exc.id)}>
                        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{exc.exchangeReference}</td>
                        <td className="px-4 py-3 text-sm text-gray-900 dark:text-white whitespace-nowrap">ETB {Number(exc.totalIncomingValue).toFixed(2)}</td>
                        <td className="px-4 py-3 text-sm text-gray-900 dark:text-white whitespace-nowrap">ETB {Number(exc.totalOutgoingValue).toFixed(2)}</td>
                        <td className="px-4 py-3 text-sm font-medium whitespace-nowrap" style={{ color: Number(exc.netBalance) > 0 ? '#d97706' : Number(exc.netBalance) < 0 ? '#2563eb' : '#6b7280' }}>
                          {Number(exc.netBalance) > 0 ? '+' : ''}{Number(exc.netBalance).toFixed(2)}
                        </td>
                        <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${SETTLEMENT_COLORS[exc.settlementType] ?? ''}`}>{exc.settlementType.replace('_', ' ')}</span></td>
                        <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[exc.lifecycleStatus ?? exc.status] ?? ''}`}>{exc.lifecycleStatus ?? exc.status}</span></td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(exc.createdAt).toLocaleString()}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 flex-wrap">
                            {/* Lifecycle-driven actions from API */}
                            {(exc.allowedActions ?? []).map(action => {
                              if (action === 'cancel') {
                                return (
                                  <button key="cancel" onClick={e => { e.stopPropagation(); if (confirm('Cancel this exchange?')) cancelMut.mutate(exc.id); }}
                                    className={`text-xs px-2 py-0.5 rounded transition-colors ${ACTION_STYLES.cancel}`}>
                                    Cancel
                                  </button>
                                );
                              }
                              if (action === 'settle') {
                                return (
                                  <button key="settle" onClick={e => { e.stopPropagation(); setSettleModal({ id: exc.id, ref: exc.exchangeReference, netBalance: Number(exc.netBalance) }); setSettlementEntries([{ entryType: Number(exc.netBalance) < 0 ? 'cash_refund' : 'cash_payment', amount: Math.abs(Number(exc.netBalance)).toFixed(2), method: 'cash', note: '' }]); }}
                                    className={`text-xs px-2 py-0.5 rounded transition-colors ${ACTION_STYLES.settle}`}>
                                    Settle
                                  </button>
                                );
                              }
                              if (action === 'print') {
                                return (
                                  <button key="print" onClick={e => { e.stopPropagation(); window.print(); }}
                                    className={`text-xs px-2 py-0.5 rounded transition-colors ${ACTION_STYLES.print}`}>
                                    🖨 Print
                                  </button>
                                );
                              }
                              return (
                                <button key={action} onClick={e => { e.stopPropagation(); actionMut.mutate({ id: exc.id, action }); }}
                                  className={`text-xs px-2 py-0.5 rounded transition-colors ${ACTION_STYLES[action] ?? 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                                  {ACTION_LABELS[action] ?? action}
                                </button>
                              );
                            })}
                            {/* Fallback for legacy exchanges without allowedActions */}
                            {!exc.allowedActions && exc.status !== 'Completed' && exc.status !== 'Cancelled' && (
                              <button onClick={e => { e.stopPropagation(); if (confirm('Cancel this exchange?')) cancelMut.mutate(exc.id); }}
                                className={`text-xs px-2 py-0.5 rounded transition-colors ${ACTION_STYLES.cancel}`}>
                                Cancel
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
          </div>
          {listData && listData.totalPages > 1 && (
            <div className="flex justify-between items-center text-sm text-gray-500 dark:text-gray-400">
              <span>Page {listData.page} of {listData.totalPages}</span>
              <div className="flex gap-2">
                <button disabled={listPage <= 1} onClick={() => setListPage(p => p - 1)} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Prev</button>
                <button disabled={listPage >= listData.totalPages} onClick={() => setListPage(p => p + 1)} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Next</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── New Exchange ── */}
      {tab === 'new' && canCreate(userRole, userPermissions) && (
        <div className="flex-1 overflow-auto p-4 pb-6 max-w-3xl mx-auto w-full space-y-4">
          {/* Location */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Location</h3>
            <select value={locationId} onChange={e => setLocationId(Number(e.target.value) || '')}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">Select location (optional)...</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
            </select>
          </div>

          {/* Customer (optional) */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Customer <span className="text-gray-400 font-normal">(optional)</span></h3>
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
                      <p className="text-xs text-gray-500 dark:text-gray-400">{b.isbn} · ETB {(b.branchPrice ?? b.defaultPrice ?? 0).toFixed(2)}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Items */}
          <div className="grid grid-cols-2 gap-4">
            {/* Incoming */}
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-green-200 dark:border-green-800 p-4 space-y-2">
              <h3 className="text-sm font-semibold text-green-700 dark:text-green-400">📥 Incoming (Customer Gives)</h3>
              {incomingItems.length === 0 ? <p className="text-xs text-gray-400">No items yet</p> : incomingItems.map(item => (
                <div key={item.bookId} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 truncate text-gray-900 dark:text-white">{item.bookTitle}</span>
                  <input type="number" min="1" value={item.quantity} onChange={e => setIncomingItems(items => items.map(i => i.bookId === item.bookId ? { ...i, quantity: parseInt(e.target.value) || 1 } : i))} className="w-12 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                  <input type="number" min="0" step="0.01" value={item.unitPrice} onChange={e => setIncomingItems(items => items.map(i => i.bookId === item.bookId ? { ...i, unitPrice: parseFloat(e.target.value) || 0 } : i))} className="w-20 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                  <button onClick={() => setIncomingItems(items => items.filter(i => i.bookId !== item.bookId))} className="text-red-500 hover:text-red-700">×</button>
                </div>
              ))}
              <div className="text-xs font-semibold text-green-700 dark:text-green-400 pt-1 border-t border-green-100 dark:border-green-900">Total: ETB {incomingTotal.toFixed(2)}</div>
            </div>
            {/* Outgoing */}
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-blue-200 dark:border-blue-800 p-4 space-y-2">
              <h3 className="text-sm font-semibold text-blue-700 dark:text-blue-400">📤 Outgoing (Customer Takes)</h3>
              {outgoingItems.length === 0 ? <p className="text-xs text-gray-400">No items yet</p> : outgoingItems.map(item => (
                <div key={item.bookId} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 truncate text-gray-900 dark:text-white">{item.bookTitle}</span>
                  <input type="number" min="1" value={item.quantity} onChange={e => setOutgoingItems(items => items.map(i => i.bookId === item.bookId ? { ...i, quantity: parseInt(e.target.value) || 1 } : i))} className="w-12 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                  <input type="number" min="0" step="0.01" value={item.unitPrice} onChange={e => setOutgoingItems(items => items.map(i => i.bookId === item.bookId ? { ...i, unitPrice: parseFloat(e.target.value) || 0 } : i))} className="w-20 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                  <button onClick={() => setOutgoingItems(items => items.filter(i => i.bookId !== item.bookId))} className="text-red-500 hover:text-red-700">×</button>
                </div>
              ))}
              <div className="text-xs font-semibold text-blue-700 dark:text-blue-400 pt-1 border-t border-blue-100 dark:border-blue-900">Total: ETB {outgoingTotal.toFixed(2)}</div>
            </div>
          </div>

          {/* Summary */}
          {(incomingItems.length > 0 || outgoingItems.length > 0) && (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
              <div className="flex justify-between text-sm"><span className="text-gray-500 dark:text-gray-400">Net Balance</span><span className={`font-semibold ${Math.abs(netBalance) < 0.01 ? 'text-gray-600 dark:text-gray-400' : netBalance > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400'}`}>ETB {netBalance.toFixed(2)}</span></div>
              <div className="flex justify-between text-sm"><span className="text-gray-500 dark:text-gray-400">Settlement</span><span className="font-medium text-gray-900 dark:text-white">{settlementType}</span></div>
              <button onClick={submitExchange} disabled={createMut.isPending}
                className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm mt-2">
                {createMut.isPending ? 'Processing...' : 'Complete Exchange'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Initiate Exchange (lifecycle) ── */}
      {tab === 'initiate' && canCreate(userRole, userPermissions) && (
        <div className="flex-1 overflow-auto p-4 pb-6 max-w-3xl mx-auto w-full space-y-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">Creates an exchange in <span className="font-semibold text-yellow-600 dark:text-yellow-400">INITIATED</span> state. Staff can then Review → Approve → Settle.</p>

          {/* Original Order (optional) */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Original Order ID <span className="text-gray-400 font-normal">(optional)</span></h3>
            <input value={initOriginalOrderId} onChange={e => setInitOriginalOrderId(e.target.value)} placeholder="e.g. ord_abc123..."
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <p className="text-xs text-gray-400">If provided, customer will be auto-inherited from the order.</p>
          </div>

          {/* Customer (optional — overrides auto-inherit) */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Customer <span className="text-gray-400 font-normal">(optional)</span></h3>
            {initSelectedCustomer ? (
              <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-950/30 rounded-lg px-3 py-2">
                <span className="text-sm text-blue-700 dark:text-blue-300">{initSelectedCustomer.fullName} <span className="text-xs text-blue-500">({initSelectedCustomer.customerCode})</span></span>
                <button onClick={() => { setInitSelectedCustomer(null); setInitCustomerSearch(''); }} className="text-gray-400 hover:text-red-500 text-sm">×</button>
              </div>
            ) : (
              <div className="relative">
                <input value={initCustomerSearch} onChange={e => setInitCustomerSearch(e.target.value)} placeholder="Search customer by name or code..."
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                {(initCustomerResults?.items ?? []).length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10">
                    {(initCustomerResults?.items ?? []).map(c => (
                      <button key={c.id} onClick={() => { setInitSelectedCustomer(c); setInitCustomerSearch(''); }}
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
              <button onClick={() => setInitAddingTo('returned')} className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${initAddingTo === 'returned' ? 'bg-green-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}>📥 Returned (Customer Gives)</button>
              <button onClick={() => setInitAddingTo('new')} className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${initAddingTo === 'new' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}>📤 New (Customer Takes)</button>
            </div>
            <div className="relative">
              <input value={initBookSearch} onChange={e => setInitBookSearch(e.target.value)} placeholder={`Search books to add as ${initAddingTo}...`}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              {(initBookResults?.items ?? []).length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
                  {(initBookResults?.items ?? []).map(b => (
                    <button key={b.id} onClick={() => addInitBook(b)} className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors border-b border-gray-100 dark:border-gray-800 last:border-0">
                      <p className="font-medium text-gray-900 dark:text-white truncate">{b.title}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{b.isbn} · ETB {(b.branchPrice ?? b.defaultPrice ?? 0).toFixed(2)}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Items grid */}
          <div className="grid grid-cols-2 gap-4">
            {/* Returned items */}
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-green-200 dark:border-green-800 p-4 space-y-2">
              <h3 className="text-sm font-semibold text-green-700 dark:text-green-400">📥 Returned Items</h3>
              {returnedItems.length === 0 ? <p className="text-xs text-gray-400">No items yet</p> : returnedItems.map(item => (
                <div key={item.bookId} className="space-y-1 text-xs border-b border-gray-100 dark:border-gray-800 pb-2 last:border-0">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate text-gray-900 dark:text-white font-medium">{item.bookTitle}</span>
                    <button onClick={() => setReturnedItems(items => items.filter(i => i.bookId !== item.bookId))} className="text-red-500 hover:text-red-700">×</button>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-gray-500 dark:text-gray-400 w-6">Qty</label>
                    <input type="number" min="1" value={item.quantity} onChange={e => setReturnedItems(items => items.map(i => i.bookId === item.bookId ? { ...i, quantity: parseInt(e.target.value) || 1 } : i))} className="w-12 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                    <label className="text-gray-500 dark:text-gray-400">ETB</label>
                    <input type="number" min="0" step="0.01" value={item.unitPrice} onChange={e => setReturnedItems(items => items.map(i => i.bookId === item.bookId ? { ...i, unitPrice: parseFloat(e.target.value) || 0 } : i))} className="w-20 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                  </div>
                  {/* Condition selector */}
                  <div className="flex gap-1">
                    {(['resellable', 'damaged'] as const).map(c => (
                      <button key={c} onClick={() => setReturnedItems(items => items.map(i => i.bookId === item.bookId ? { ...i, condition: c } : i))}
                        className={`flex-1 py-0.5 rounded text-xs transition-colors capitalize ${item.condition === c ? (c === 'resellable' ? 'bg-green-600 text-white' : 'bg-red-600 text-white') : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}>
                        {c === 'resellable' ? '✓ Resellable' : '⚠ Damaged'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <div className="text-xs font-semibold text-green-700 dark:text-green-400 pt-1 border-t border-green-100 dark:border-green-900">Total: ETB {returnedTotal.toFixed(2)}</div>
            </div>
            {/* New items */}
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-blue-200 dark:border-blue-800 p-4 space-y-2">
              <h3 className="text-sm font-semibold text-blue-700 dark:text-blue-400">📤 New Items</h3>
              {newItems.length === 0 ? <p className="text-xs text-gray-400">No items yet</p> : newItems.map(item => (
                <div key={item.bookId} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 truncate text-gray-900 dark:text-white">{item.bookTitle}</span>
                  <input type="number" min="1" value={item.quantity} onChange={e => setNewItems(items => items.map(i => i.bookId === item.bookId ? { ...i, quantity: parseInt(e.target.value) || 1 } : i))} className="w-12 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                  <input type="number" min="0" step="0.01" value={item.unitPrice} onChange={e => setNewItems(items => items.map(i => i.bookId === item.bookId ? { ...i, unitPrice: parseFloat(e.target.value) || 0 } : i))} className="w-20 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                  <button onClick={() => setNewItems(items => items.filter(i => i.bookId !== item.bookId))} className="text-red-500 hover:text-red-700">×</button>
                </div>
              ))}
              <div className="text-xs font-semibold text-blue-700 dark:text-blue-400 pt-1 border-t border-blue-100 dark:border-blue-900">Total: ETB {newItemsTotal.toFixed(2)}</div>
            </div>
          </div>

          {/* Notes */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Notes <span className="text-gray-400 font-normal">(optional)</span></h3>
            <textarea value={initNotes} onChange={e => setInitNotes(e.target.value)} rows={2} placeholder="Any notes about this exchange..."
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>

          {/* Summary */}
          {(returnedItems.length > 0 || newItems.length > 0) && (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
              <div className="flex justify-between text-sm"><span className="text-gray-500 dark:text-gray-400">Returned Value</span><span className="text-green-600 dark:text-green-400">ETB {returnedTotal.toFixed(2)}</span></div>
              <div className="flex justify-between text-sm"><span className="text-gray-500 dark:text-gray-400">New Items Value</span><span className="text-blue-600 dark:text-blue-400">ETB {newItemsTotal.toFixed(2)}</span></div>
              <div className="flex justify-between text-sm font-semibold border-t border-gray-200 dark:border-gray-700 pt-2">
                <span className="text-gray-700 dark:text-gray-300">Net Balance</span>
                <span className={Math.abs(initNetBalance) < 0.01 ? 'text-gray-600 dark:text-gray-400' : initNetBalance > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400'}>
                  {initNetBalance > 0 ? '+' : ''}{initNetBalance.toFixed(2)} ETB
                  {Math.abs(initNetBalance) > 0.01 && <span className="text-xs font-normal ml-1">({initNetBalance > 0 ? 'Customer pays' : 'Store refunds'})</span>}
                </span>
              </div>
              <button onClick={submitInitiate} disabled={initiateMut.isPending}
                className="w-full bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm mt-2">
                {initiateMut.isPending ? 'Initiating...' : 'Initiate Exchange'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Settle Modal ── */}
      {settleModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setSettleModal(null)}>
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 w-full max-w-lg space-y-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Settle Exchange</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              <span className="font-mono font-medium text-gray-900 dark:text-white">{settleModal.ref}</span>
              {' · '}Net balance: <span className={`font-semibold ${Math.abs(settleModal.netBalance) < 0.01 ? 'text-gray-600' : settleModal.netBalance > 0 ? 'text-amber-600' : 'text-blue-600'}`}>
                {settleModal.netBalance > 0 ? '+' : ''}{settleModal.netBalance.toFixed(2)} ETB
              </span>
            </p>

            <div className="space-y-3 max-h-64 overflow-y-auto">
              {settlementEntries.map((entry, idx) => (
                <div key={idx} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Entry {idx + 1}</span>
                    {settlementEntries.length > 1 && <button onClick={() => removeSettlementEntry(idx)} className="text-xs text-red-500 hover:text-red-700">Remove</button>}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-0.5">Type</label>
                      <select value={entry.entryType} onChange={e => setSettlementEntries(prev => prev.map((en, i) => i === idx ? { ...en, entryType: e.target.value as SettlementEntry['entryType'] } : en))}
                        className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-purple-500">
                        <option value="cash_payment">Payment (Customer Pays)</option>
                        <option value="cash_refund">Refund (Store Refunds)</option>
                        <option value="item_value_adjustment">Value Adjustment</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-0.5">Amount (ETB)</label>
                      <input type="number" min="0" step="0.01" value={entry.amount} onChange={e => setSettlementEntries(prev => prev.map((en, i) => i === idx ? { ...en, amount: e.target.value } : en))}
                        className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-purple-500" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-0.5">Method</label>
                      <select value={entry.method} onChange={e => setSettlementEntries(prev => prev.map((en, i) => i === idx ? { ...en, method: e.target.value } : en))}
                        className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-purple-500">
                        <option value="cash">Cash</option>
                        <option value="bank">Bank</option>
                        <option value="store_credit">Store Credit</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-0.5">Note (optional)</label>
                    <input value={entry.note} onChange={e => setSettlementEntries(prev => prev.map((en, i) => i === idx ? { ...en, note: e.target.value } : en))} placeholder="e.g. negotiated discount..."
                      className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-purple-500" />
                  </div>
                </div>
              ))}
            </div>

            <button onClick={addSettlementEntry} className="w-full text-xs py-1.5 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
              + Add Entry
            </button>

            <div className="flex justify-between text-sm font-semibold border-t border-gray-200 dark:border-gray-700 pt-2">
              <span className="text-gray-700 dark:text-gray-300">Settlement Total</span>
              <span className={`${Math.abs(settlementTotal - Math.abs(settleModal.netBalance)) < 0.01 ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                ETB {settlementTotal.toFixed(2)}
              </span>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setSettleModal(null)} className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Cancel</button>
              <button
                onClick={() => settleMut.mutate({ id: settleModal.id, entries: settlementEntries })}
                disabled={settleMut.isPending || settlementEntries.every(e => !parseFloat(e.amount))}
                className="flex-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-semibold py-2 rounded-lg transition-colors">
                {settleMut.isPending ? 'Settling...' : 'Confirm Settlement'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ExchangeDetailLoader({ exchangeId }: { exchangeId: string }) {
  const { data } = useQuery<{ incomingItems?: ExchangeItem[]; outgoingItems?: ExchangeItem[] }>({
    queryKey: ['exchange-detail', exchangeId],
    queryFn: () => api.get(`/exchanges/${exchangeId}`),
  });
  if (!data) return <p className="text-xs text-gray-400">Loading...</p>;
  return (
    <div className="grid grid-cols-2 gap-4 text-xs">
      <div>
        <p className="font-semibold text-green-700 dark:text-green-400 mb-1">Incoming</p>
        {(data.incomingItems ?? []).map((i, idx) => <p key={idx} className="text-gray-700 dark:text-gray-300">{i.bookTitle} × {i.quantity} @ ETB {Number(i.unitPrice).toFixed(2)}</p>)}
      </div>
      <div>
        <p className="font-semibold text-blue-700 dark:text-blue-400 mb-1">Outgoing</p>
        {(data.outgoingItems ?? []).map((i, idx) => <p key={idx} className="text-gray-700 dark:text-gray-300">{i.bookTitle} × {i.quantity} @ ETB {Number(i.unitPrice).toFixed(2)}</p>)}
      </div>
    </div>
  );
}
