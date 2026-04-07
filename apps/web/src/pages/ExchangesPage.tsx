import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

type Role = string;
interface ExchangesPageProps { userRole?: Role; }

interface ExchangeItem { id: string; bookId: number; bookTitle: string; quantity: number; unitPrice: number; totalPrice: number; }
interface Exchange { id: string; exchangeReference: string; status: string; settlementType: string; totalIncomingValue: number; totalOutgoingValue: number; netBalance: number; currency: string; createdAt: string; incomingItems?: ExchangeItem[]; outgoingItems?: ExchangeItem[]; }
interface ExchangeListResponse { items: Exchange[]; total: number; page: number; totalPages: number; }
interface BookResult { id: number; title: string; isbn: string; defaultPrice: number | null; branchPrice: number | null; }

const STATUS_COLORS: Record<string, string> = {
  Initiated: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  Evaluated: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  Completed: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  Cancelled: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
};
const SETTLEMENT_COLORS: Record<string, string> = {
  Even: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  Customer_Pays: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  Store_Refunds: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
};

const canCreate = (r?: Role) => ['Sales', 'Manager', 'Admin'].includes(r ?? '');
const canCancel = (r?: Role) => ['Manager', 'Admin'].includes(r ?? '');

type Tab = 'list' | 'new';

export default function ExchangesPage({ userRole }: ExchangesPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const branchId = getCurrentBranchId() ?? 1;
  const [tab, setTab] = useState<Tab>('list');

  // List state
  const [listPage, setListPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // New exchange state
  const [locationId, setLocationId] = useState<number | ''>('');
  const [bookSearch, setBookSearch] = useState('');
  const [incomingItems, setIncomingItems] = useState<Array<{ bookId: number; bookTitle: string; quantity: number; unitPrice: number }>>([]);
  const [outgoingItems, setOutgoingItems] = useState<Array<{ bookId: number; bookTitle: string; quantity: number; unitPrice: number }>>([]);
  const [addingTo, setAddingTo] = useState<'incoming' | 'outgoing'>('incoming');

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

  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<Exchange>('/exchanges', body),
    onSuccess: (e) => {
      showToast(`Exchange ${e.exchangeReference} completed`, 'success');
      setIncomingItems([]); setOutgoingItems([]); setBookSearch('');
      qc.invalidateQueries({ queryKey: ['exchanges-list'] });
      setTab('list');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => api.post<Exchange>(`/exchanges/${id}/cancel`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['exchanges-list'] }); showToast('Exchange cancelled', 'success'); },
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
      incomingItems: incomingItems.map(i => ({ bookId: i.bookId, quantity: i.quantity, unitPrice: i.unitPrice })),
      outgoingItems: outgoingItems.map(i => ({ bookId: i.bookId, quantity: i.quantity, unitPrice: i.unitPrice })),
    });
  }

  const locations = locData?.items ?? [];

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex-shrink-0">
        {(['list', 'new'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-medium transition-colors ${tab === t ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {t === 'list' ? '🔁 Exchanges' : '+ New Exchange'}
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
                    <>
                      <tr key={exc.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer" onClick={() => setExpandedId(expandedId === exc.id ? null : exc.id)}>
                        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{exc.exchangeReference}</td>
                        <td className="px-4 py-3 text-sm text-gray-900 dark:text-white whitespace-nowrap">ETB {Number(exc.totalIncomingValue).toFixed(2)}</td>
                        <td className="px-4 py-3 text-sm text-gray-900 dark:text-white whitespace-nowrap">ETB {Number(exc.totalOutgoingValue).toFixed(2)}</td>
                        <td className="px-4 py-3 text-sm font-medium whitespace-nowrap" style={{ color: Number(exc.netBalance) > 0 ? '#d97706' : Number(exc.netBalance) < 0 ? '#2563eb' : '#6b7280' }}>
                          {Number(exc.netBalance) > 0 ? '+' : ''}{Number(exc.netBalance).toFixed(2)}
                        </td>
                        <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${SETTLEMENT_COLORS[exc.settlementType] ?? ''}`}>{exc.settlementType.replace('_', ' ')}</span></td>
                        <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[exc.status] ?? ''}`}>{exc.status}</span></td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(exc.createdAt).toLocaleString()}</td>
                        <td className="px-4 py-3">
                          {canCancel(userRole) && exc.status !== 'Completed' && exc.status !== 'Cancelled' && (
                            <button onClick={e => { e.stopPropagation(); if (confirm('Cancel this exchange?')) cancelMut.mutate(exc.id); }} className="text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950 px-2 py-0.5 rounded transition-colors">Cancel</button>
                          )}
                        </td>
                      </tr>
                      {expandedId === exc.id && (
                        <tr key={`${exc.id}-detail`}>
                          <td colSpan={8} className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50">
                            <ExchangeDetailLoader exchangeId={exc.id} />
                          </td>
                        </tr>
                      )}
                    </>
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
      {tab === 'new' && canCreate(userRole) && (
        <div className="flex-1 overflow-auto p-4 max-w-3xl mx-auto w-full space-y-4">
          {/* Location */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Location</h3>
            <select value={locationId} onChange={e => setLocationId(Number(e.target.value) || '')}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">Select location (optional)...</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
            </select>
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
