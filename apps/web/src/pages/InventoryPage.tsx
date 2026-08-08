// InventoryPage — Slice 7
// Sub-pages: Stock Levels | Stock In | Stock Out | Adjust | Transfer | History | Low Stock Alerts
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../components/Pagination.js';

type Role = string;
type Tab = 'stock' | 'stock-in' | 'stock-out' | 'adjust' | 'transfer' | 'history' | 'alerts';

interface InventoryRow {
  bookId: number; bookTitle: string; bookIsbn: string; bookIsActive: boolean;
  locationId: number; locationName: string; branchId: number;
  quantity: number; reserved: number; available: number;
  reorderPoint: number; version: number;
  isLowStock: boolean; updatedAt: string;
}
interface InventoryList { items: InventoryRow[]; total: number; page: number; totalPages: number; }

interface HistoryRow {
  id: string; bookId: number; bookTitle: string;
  locationId: number; locationName: string;
  qtyBefore: number; qtyAfter: number; delta: number;
  movementType: string; reasonCode: string;
  referenceType: string | null; referenceId: string | null;
  notes: string | null;
  staffId: number; staffUsername: string; createdAt: string;
}
interface HistoryList { items: HistoryRow[]; total: number; page: number; totalPages: number; }

const MOVEMENT_LABELS: Record<string, string> = {
  stock_in:     'Stock In',
  stock_out:    'Stock Out',
  transfer_in:  'Transfer In',
  transfer_out: 'Transfer Out',
  adjustment:   'Adjustment',
};

const REASON_LABELS: Record<string, string> = {
  damage: 'Damage', loss: 'Loss', return: 'Return', correction: 'Correction',
  transfer_in: 'Transfer In', transfer_out: 'Transfer Out', initial: 'Initial',
  stock_in: 'Stock In', stock_out: 'Stock Out',
};

const canWrite = (role: Role | undefined, perms?: string[]) =>
  (perms && perms.includes('MANAGE_INVENTORY')) ||
  role === 'Admin' || role === 'Manager' || role === 'Stock_Clerk';
const canManage = (role: Role | undefined, perms?: string[]) =>
  (perms && (perms.includes('MANAGE_STAFF') || perms.includes('MANAGE_BRANCH'))) ||
  role === 'Admin' || role === 'Manager';
const canStockOut = (role: Role | undefined, perms?: string[]) =>
  (perms && (perms.includes('MANAGE_INVENTORY') || perms.includes('CREATE_SALE'))) ||
  role === 'Admin' || role === 'Manager' || role === 'Stock_Clerk' || role === 'Sales';

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDateShort(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function InventoryPage({ userRole, userPermissions, initialContext = {} }: { userRole?: Role; userPermissions?: string[]; initialContext?: Record<string, string> }) {
  const [tab, setTab] = useState<Tab>('stock');
  const tabs = [
    { id: 'stock' as Tab, label: 'Stock Levels', icon: '📦' },
    { id: 'stock-in' as Tab, label: 'Stock In', icon: '⬇️' },
    { id: 'stock-out' as Tab, label: 'Stock Out', icon: '⬆️' },
    { id: 'adjust' as Tab, label: 'Adjust', icon: '✏️' },
    { id: 'transfer' as Tab, label: 'Transfer', icon: '↔️' },
    { id: 'history' as Tab, label: 'History', icon: '📋' },
    { id: 'alerts' as Tab, label: 'Low Stock', icon: '⚠️' },
  ];

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 flex gap-1 flex-shrink-0">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            <span>{t.icon}</span>{t.label}
            {t.id === 'alerts' && <AlertBadge />}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'stock'    && <StockLevelsTab userRole={userRole} userPermissions={userPermissions} onNavigate={setTab} initialLowOnly={initialContext.lowStockOnly === 'true'} />}
        {tab === 'stock-in' && <StockInTab userRole={userRole} userPermissions={userPermissions} />}
        {tab === 'stock-out' && <StockOutTab userRole={userRole} userPermissions={userPermissions} />}
        {tab === 'adjust'   && <AdjustTab userRole={userRole} userPermissions={userPermissions} />}
        {tab === 'transfer' && <TransferTab userRole={userRole} userPermissions={userPermissions} />}
        {tab === 'history'  && <HistoryTab />}
        {tab === 'alerts'   && <AlertsTab userRole={userRole} userPermissions={userPermissions} />}
      </div>
    </div>
  );
}

// ── AlertBadge — shows count of low-stock items ───────────────────────────────
function AlertBadge() {
  const { data } = useQuery<{ items: InventoryRow[]; total: number }>({
    queryKey: ['inventory-low-stock'],
    queryFn: () => api.get('/inventory/low-stock'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  if (!data?.total) return null;
  return (
    <span className="ml-1 px-1.5 py-0.5 bg-amber-500 text-white text-xs rounded-full leading-none font-semibold">
      {data.total}
    </span>
  );
}

// ── Stock Levels Tab ──────────────────────────────────────────────────────────
function StockLevelsTab({ userRole, userPermissions, onNavigate, initialLowOnly = false }: { userRole?: Role; userPermissions?: string[]; onNavigate?: (tab: Tab) => void; initialLowOnly?: boolean }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [q, setQ] = useState('');
  const [lowOnly, setLowOnly] = useState(initialLowOnly);
  // Deactivated books are hidden by default — they can't be sold, reordered,
  // or restocked any more, so Stock Levels/Adjust/Transfer/Stock In/Stock Out
  // shouldn't surface them for selection. This checkbox is an explicit
  // audit-only escape hatch to see them without reactivating first.
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [editRow, setEditRow] = useState<InventoryRow | null>(null);
  const [newReorder, setNewReorder] = useState('');

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (lowOnly) params.set('lowStockOnly', 'true');
  if (includeInactive) params.set('includeInactive', 'true');
  params.set('page', String(page)); params.set('pageSize', String(pageSize));

  const { data, isLoading, isFetching, isError, refetch } = useQuery<InventoryList>({
    queryKey: ['inventory', q, lowOnly, includeInactive, page, pageSize],
    queryFn: () => api.get<InventoryList>(`/inventory?${params.toString()}`),
    placeholderData: prev => prev,
    staleTime: 0,
    retry: 2,
    refetchOnWindowFocus: true,
  });

  const reorderMut = useMutation({
    mutationFn: ({ bookId, locId, rp }: { bookId: number; locId: number; rp: number }) =>
      api.put('/inventory/reorder-point', { bookId, locationId: locId, reorderPoint: rp }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['inventory'] }); showToast('Reorder point updated', 'success'); setEditRow(null); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-2 flex items-center gap-2 flex-shrink-0 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input value={q} onChange={e => { setQ(e.target.value); setPage(1); }} placeholder="Search books…"
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
          <input type="checkbox" checked={lowOnly} onChange={e => { setLowOnly(e.target.checked); setPage(1); }} className="rounded border-gray-300 dark:border-gray-600 text-amber-500" />
          Low stock only
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 cursor-pointer" title="Deactivated books are hidden from search and stock actions by default">
          <input type="checkbox" checked={includeInactive} onChange={e => { setIncludeInactive(e.target.checked); setPage(1); }} className="rounded border-gray-300 dark:border-gray-600 text-gray-500" />
          Show inactive books
        </label>
        <div className="flex-1" />
        <span className="text-xs text-gray-400">{isLoading ? '…' : `${data?.total ?? 0} records`}{isFetching && !isLoading && ' ↻'}</span>
      </div>

      {/* Error state */}
      {isError && (
        <div className="flex items-center justify-center gap-3 px-4 py-3 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
          <span>Failed to load inventory.</span>
          <button onClick={() => refetch()} className="px-3 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors font-medium">Retry</button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-gray-50 dark:bg-gray-800/80 sticky top-0 z-10">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Book</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Location</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">On Hand</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Reserved</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Available</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Reorder At</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Updated</th>
              {canManage(userRole, userPermissions) && <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
            {isLoading ? [...Array(6)].map((_, i) => <SkeletonRow key={i} cols={canManage(userRole, userPermissions) ? 9 : 8} />) :
             !data?.items.length ? (
              <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-400 text-sm">No inventory records found</td></tr>
            ) : data.items.map(row => (
              <tr key={`${row.bookId}-${row.locationId}`} className={`hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors ${row.isLowStock ? 'bg-amber-50/50 dark:bg-amber-950/20' : ''}`}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <div className="font-medium text-gray-900 dark:text-white text-sm line-clamp-1">{row.bookTitle}</div>
                    {!row.bookIsActive && (
                      <span className="flex-shrink-0 text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 rounded-full font-medium">Inactive</span>
                    )}
                  </div>
                  <div className="text-xs font-mono text-gray-400">{row.bookIsbn}</div>
                </td>
                <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{row.locationName}</td>
                <td className="px-4 py-3 text-right">
                  <span className={`text-sm font-semibold ${row.isLowStock ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-white'}`}>
                    {row.quantity}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-sm text-gray-400 dark:text-gray-500">{row.reserved}</td>
                <td className="px-4 py-3 text-right">
                  <span className={`text-sm font-semibold ${row.available === 0 ? 'text-red-500 dark:text-red-400' : row.isLowStock ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {row.available}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-sm text-gray-500 dark:text-gray-400">{row.reorderPoint}</td>
                <td className="px-4 py-3 text-center">
                  {row.isLowStock ? (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400 rounded-full font-medium">⚠ Low</span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400 rounded-full font-medium">OK</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-gray-400">{fmtDateShort(row.updatedAt)}</td>
                {canManage(userRole, userPermissions) && (
                  <td className="px-4 py-3 text-right">
                    {editRow?.bookId === row.bookId && editRow?.locationId === row.locationId ? (
                      <div className="flex items-center gap-1 justify-end">
                        <input type="number" value={newReorder} onChange={e => setNewReorder(e.target.value)} min="0"
                          className="w-16 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                        <button onClick={() => reorderMut.mutate({ bookId: row.bookId, locId: row.locationId, rp: parseInt(newReorder, 10) })}
                          className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors">✓</button>
                        <button onClick={() => setEditRow(null)} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">✕</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 justify-end opacity-40 group-hover:opacity-100 transition-opacity">
                        <QuickStockButton row={row} type="in" onNavigate={onNavigate} />
                        <QuickStockButton row={row} type="out" onNavigate={onNavigate} />
                        <button onClick={() => { setEditRow(row); setNewReorder(String(row.reorderPoint)); }}
                          className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                          ⚙
                        </button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && (
        <Pagination
          page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
          itemLabel="inventory record"
        />
      )}
    </div>
  );
}

// ── Adjust Tab ────────────────────────────────────────────────────────────────
function AdjustTab({ userRole, userPermissions }: { userRole?: Role; userPermissions?: string[] }) {
  const qc = useQueryClient();
  const [bookSearch, setBookSearch] = useState('');
  const [selectedBook, setSelectedBook] = useState<InventoryRow | null>(null);
  const [delta, setDelta] = useState('');
  const [reasonCode, setReasonCode] = useState<'damage' | 'loss' | 'return' | 'correction'>('correction');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const { data: stockData } = useQuery<InventoryList>({
    queryKey: ['inventory', bookSearch, '', false, 1],
    queryFn: () => api.get<InventoryList>(`/inventory?q=${encodeURIComponent(bookSearch)}&pageSize=10`),
    enabled: bookSearch.length > 1,
  });

  if (!canWrite(userRole, userPermissions)) {
    return <AccessDenied />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBook) { setError('Select a book and location first'); return; }
    const d = parseInt(delta, 10);
    if (isNaN(d) || d === 0) { setError('Enter a non-zero quantity'); return; }
    setError(''); setSaving(true); setSuccess('');
    try {
      const result = await api.post<InventoryRow>('/inventory/adjust', {
        bookId: selectedBook.bookId,
        locationId: selectedBook.locationId,
        delta: d,
        reasonCode,
        notes: notes || undefined,
        version: selectedBook.version,
      });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-low-stock'] });
      setSuccess(`Done. New quantity: ${result.quantity}`);
      setSelectedBook({ ...selectedBook, quantity: result.quantity, version: result.version });
      setDelta(''); setNotes('');
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string };
      if (e.code === 'VERSION_CONFLICT') {
        setError('Inventory was updated by someone else. Refreshing…');
        qc.invalidateQueries({ queryKey: ['inventory'] });
      } else {
        setError(e.message ?? 'Unknown error');
      }
    } finally { setSaving(false); }
  }

  return (
    <div className="flex h-full">
      {/* Left: book selector */}
      <div className="w-80 flex-shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Select Book + Location</p>
          <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="Search books…"
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {stockData?.items.map(row => (
            <button key={`${row.bookId}-${row.locationId}`}
              onClick={() => { setSelectedBook(row); setError(''); setSuccess(''); }}
              className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${selectedBook?.bookId === row.bookId && selectedBook?.locationId === row.locationId ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}>
              <div className="text-sm font-medium text-gray-900 dark:text-white line-clamp-1">{row.bookTitle}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{row.locationName} · Qty: <span className={row.isLowStock ? 'text-amber-600 font-semibold' : 'font-semibold'}>{row.quantity}</span></div>
            </button>
          ))}
          {bookSearch.length > 1 && !stockData?.items.length && (
            <p className="px-4 py-3 text-xs text-gray-400 italic">No results</p>
          )}
          {bookSearch.length <= 1 && (
            <p className="px-4 py-3 text-xs text-gray-400 italic">Type to search books…</p>
          )}
        </div>
      </div>

      {/* Right: adjustment form */}
      <div className="flex-1 overflow-auto flex items-start justify-center p-8">
        <div className="w-full max-w-md pb-6">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-1">Stock Adjustment</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">Record a manual stock change with a reason code.</p>

          {selectedBook ? (
            <div className="mb-5 p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
              <div className="font-medium text-blue-900 dark:text-blue-200">{selectedBook.bookTitle}</div>
              <div className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">{selectedBook.locationName} · Current qty: <strong>{selectedBook.quantity}</strong></div>
            </div>
          ) : (
            <div className="mb-5 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm text-gray-500 dark:text-gray-400">
              ← Select a book and location from the left panel
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">{error}</div>}
            {success && <div className="p-3 bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded-lg text-sm text-emerald-700 dark:text-emerald-300">{success}</div>}

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Quantity Change *</label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setDelta(d => d.startsWith('-') ? d.slice(1) : d ? `-${d}` : '-')}
                  className={`px-3 py-2 text-sm border rounded-lg transition-colors ${delta.startsWith('-') ? 'bg-red-100 border-red-300 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-400' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                  {delta.startsWith('-') ? '− Remove' : '+ Add'}
                </button>
                <input type="number" value={delta.replace('-', '')} onChange={e => setDelta(delta.startsWith('-') ? `-${e.target.value}` : e.target.value)}
                  min="1" placeholder="0"
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              {selectedBook && delta && !isNaN(parseInt(delta, 10)) && (
                <p className="text-xs text-gray-400 mt-1">
                  New quantity: <strong>{selectedBook.quantity + parseInt(delta, 10)}</strong>
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reason *</label>
              <select value={reasonCode} onChange={e => setReasonCode(e.target.value as typeof reasonCode)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="correction">Correction (count discrepancy)</option>
                <option value="damage">Damage</option>
                <option value="loss">Loss / Theft</option>
                <option value="return">Customer Return</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Additional context…"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white resize-none focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <button type="submit" disabled={saving || !selectedBook}
              className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
              {saving ? 'Saving…' : 'Record Adjustment'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Transfer Tab ──────────────────────────────────────────────────────────────
function TransferTab({ userRole, userPermissions }: { userRole?: Role; userPermissions?: string[] }) {
  const qc = useQueryClient();
  const [bookSearch, setBookSearch] = useState('');
  const [selectedBook, setSelectedBook] = useState<InventoryRow | null>(null);
  const [toLocationId, setToLocationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Use the selected book's branchId, or fall back to the current session branch
  const targetBranchId = selectedBook?.branchId ?? getCurrentBranchId() ?? 0;

  const { data: stockData } = useQuery<InventoryList>({
    queryKey: ['inventory', bookSearch, '', false, 1],
    queryFn: () => api.get<InventoryList>(`/inventory?q=${encodeURIComponent(bookSearch)}&pageSize=10`),
    enabled: bookSearch.length > 1,
  });

  // Always fetch locations for the target branch — populated on mount, updates when book changes
  const { data: branchLocations } = useQuery<{ items: Array<{ id: number; name: string; isDefaultFulfillment: boolean }> }>({
    queryKey: ['branch-locations-transfer', targetBranchId],
    queryFn: () => api.get(`/branches/${targetBranchId}/locations`),
    enabled: targetBranchId > 0,
    staleTime: 60_000,
  });

  // Exclude the source location from the destination list
  const availableLocations = (branchLocations?.items ?? []).filter(
    l => l.id !== selectedBook?.locationId
  );

  if (!canWrite(userRole, userPermissions)) return <AccessDenied />;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBook) { setError('Select a source book and location'); return; }
    if (!toLocationId) { setError('Select a destination location'); return; }
    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty <= 0) { setError('Enter a positive quantity'); return; }
    if (parseInt(toLocationId, 10) === selectedBook.locationId) { setError('Source and destination must differ'); return; }
    setError(''); setSaving(true); setSuccess('');
    try {
      const result = await api.post<{ from: InventoryRow; to: InventoryRow }>('/inventory/transfer', {
        bookId: selectedBook.bookId,
        fromLocationId: selectedBook.locationId,
        toLocationId: parseInt(toLocationId, 10),
        quantity: qty,
        fromVersion: selectedBook.version,
      });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-low-stock'] });
      setSuccess(`Transferred ${qty} units. From: ${result.from.quantity} remaining. To: ${result.to.quantity} now.`);
      setSelectedBook({ ...selectedBook, quantity: result.from.quantity, version: result.from.version });
      setQuantity('');
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string };
      if (e.code === 'VERSION_CONFLICT') {
        setError('Source inventory changed. Refreshing…');
        qc.invalidateQueries({ queryKey: ['inventory'] });
      } else {
        setError(e.message ?? 'Unknown error');
      }
    } finally { setSaving(false); }
  }

  return (
    <div className="flex h-full">
      {/* Left: source selector */}
      <div className="w-80 flex-shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Source (Book + Location)</p>
          <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="Search books…"
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {stockData?.items.map(row => (
            <button key={`${row.bookId}-${row.locationId}`}
              onClick={() => { setSelectedBook(row); setError(''); setSuccess(''); }}
              className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${selectedBook?.bookId === row.bookId && selectedBook?.locationId === row.locationId ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}>
              <div className="text-sm font-medium text-gray-900 dark:text-white line-clamp-1">{row.bookTitle}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{row.locationName} · Qty: <strong>{row.quantity}</strong></div>
            </button>
          ))}
          {bookSearch.length <= 1 && <p className="px-4 py-3 text-xs text-gray-400 italic">Type to search books…</p>}
        </div>
      </div>

      {/* Right: transfer form */}
      <div className="flex-1 overflow-auto flex items-start justify-center p-8">
        <div className="w-full max-w-md pb-6">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-1">Stock Transfer</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">Move stock between locations within this branch.</p>

          {selectedBook ? (
            <div className="mb-5 p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
              <div className="font-medium text-blue-900 dark:text-blue-200">{selectedBook.bookTitle}</div>
              <div className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">From: {selectedBook.locationName} · Available: <strong>{selectedBook.quantity}</strong></div>
            </div>
          ) : (
            <div className="mb-5 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm text-gray-500 dark:text-gray-400">
              ← Select a source book and location
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">{error}</div>}
            {success && <div className="p-3 bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded-lg text-sm text-emerald-700 dark:text-emerald-300">{success}</div>}

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Destination Location *</label>
              <select value={toLocationId} onChange={e => setToLocationId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— Select destination —</option>
                {availableLocations.map(l => (
                  <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Quantity *</label>
              <input type="number" value={quantity} onChange={e => setQuantity(e.target.value)} min="1"
                placeholder="Units to transfer"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <button type="submit" disabled={saving || !selectedBook || !toLocationId}
              className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
              {saving ? 'Transferring…' : 'Transfer Stock'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── History Tab ───────────────────────────────────────────────────────────────
function HistoryTab() {
  const [movementType, setMovementType] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const params = new URLSearchParams();
  if (movementType) params.set('movementType', movementType);
  if (reasonCode) params.set('reasonCode', reasonCode);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  params.set('page', String(page)); params.set('pageSize', String(pageSize));

  const { data, isLoading, isFetching } = useQuery<HistoryList>({
    queryKey: ['inventory-history', movementType, reasonCode, dateFrom, dateTo, page, pageSize],
    queryFn: () => api.get<HistoryList>(`/inventory/history?${params.toString()}`),
    placeholderData: prev => prev,
  });

  return (
    <div className="flex flex-col h-full">
      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-2 flex items-center gap-3 flex-shrink-0 flex-wrap">
        <select value={movementType} onChange={e => { setMovementType(e.target.value); setPage(1); }}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Types</option>
          {Object.entries(MOVEMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={reasonCode} onChange={e => { setReasonCode(e.target.value); setPage(1); }}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Reasons</option>
          {Object.entries(REASON_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <span className="text-xs text-gray-400">to</span>
        <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        {(movementType || reasonCode || dateFrom || dateTo) && (
          <button onClick={() => { setMovementType(''); setReasonCode(''); setDateFrom(''); setDateTo(''); setPage(1); }}
            className="text-xs text-gray-400 hover:text-red-500 transition-colors">Clear</button>
        )}
        <div className="flex-1" />
        <span className="text-xs text-gray-400">{isLoading ? '…' : `${data?.total ?? 0} records`}{isFetching && !isLoading && ' ↻'}</span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-gray-50 dark:bg-gray-800/80 sticky top-0 z-10">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Book</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Location</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Before</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Delta</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">After</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Reason</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">By</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
            {isLoading ? [...Array(6)].map((_, i) => <SkeletonRow key={i} cols={8} />) :
             !data?.items.length ? (
              <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400 text-sm">No history records found</td></tr>
            ) : data.items.map(h => (
              <tr key={h.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                <td className="px-4 py-3 text-sm text-gray-900 dark:text-white max-w-[180px]">
                  <span className="line-clamp-1">{h.bookTitle}</span>
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">{h.locationName}</td>
                <td className="px-4 py-3 text-right text-sm text-gray-500 dark:text-gray-400">{h.qtyBefore}</td>
                <td className="px-4 py-3 text-right">
                  <span className={`text-sm font-semibold ${h.delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                    {h.delta > 0 ? `+${h.delta}` : h.delta}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-sm font-semibold text-gray-900 dark:text-white">{h.qtyAfter}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-1">
                    <MovementBadge type={h.movementType} />
                    {h.referenceType && (
                      <span className="text-xs text-gray-400">{h.referenceType}{h.referenceId ? ` #${h.referenceId}` : ''}</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">{h.staffUsername}</td>
                <td className="px-4 py-3 text-xs text-gray-400">{fmtDate(h.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && (
        <Pagination
          page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
          itemLabel="history entry"
        />
      )}
    </div>
  );
}

// ── Low Stock Alerts Tab ──────────────────────────────────────────────────────
function AlertsTab({ userRole: _userRole, userPermissions: _userPermissions }: { userRole?: Role; userPermissions?: string[] }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { data, isLoading, refetch } = useQuery<{ items: InventoryRow[]; total: number; page: number; totalPages: number }>({
    queryKey: ['inventory-low-stock', page, pageSize],
    queryFn: () => api.get(`/inventory/low-stock?page=${page}&pageSize=${pageSize}`),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-2 flex items-center gap-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-amber-500 text-lg">⚠️</span>
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-white">Low Stock Alerts</p>
            <p className="text-xs text-gray-400">Books at or below their reorder point. Auto-refreshes every 60s.</p>
          </div>
        </div>
        <div className="flex-1" />
        <span className="text-xs text-gray-400">{data?.total ?? 0} items</span>
        <button onClick={() => refetch()} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Refresh</button>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading…</div>
        ) : !data?.items.length ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
            <span className="text-5xl">✅</span>
            <p className="text-gray-500 dark:text-gray-400 font-medium">All stock levels are healthy</p>
            <p className="text-xs text-gray-400">No books are at or below their reorder point.</p>
          </div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead className="bg-amber-50 dark:bg-amber-950/30 sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Book</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Location</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Current Qty</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Reorder At</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Deficit</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Last Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-amber-100 dark:divide-amber-900/30 bg-white dark:bg-gray-900">
              {data.items.map(row => (
                <tr key={`${row.bookId}-${row.locationId}`} className="hover:bg-amber-50/50 dark:hover:bg-amber-950/20 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 dark:text-white text-sm line-clamp-1">{row.bookTitle}</div>
                    <div className="text-xs font-mono text-gray-400">{row.bookIsbn}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{row.locationName}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-sm font-bold text-amber-600 dark:text-amber-400">{row.quantity}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-gray-500 dark:text-gray-400">{row.reorderPoint}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-sm font-semibold text-red-600 dark:text-red-400">
                      {row.reorderPoint - row.quantity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">{fmtDateShort(row.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {data && data.items.length > 0 && (
        <Pagination
          page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
          itemLabel="low-stock item"
        />
      )}
    </div>
  );
}

// ── Shared UI components ──────────────────────────────────────────────────────

function AccessDenied() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <p className="text-4xl mb-3">🔒</p>
        <p className="text-gray-500 dark:text-gray-400 font-medium">Access restricted</p>
        <p className="text-xs text-gray-400 mt-1">Admin, Manager, or Stock_Clerk role required</p>
      </div>
    </div>
  );
}

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="animate-pulse">
      {[...Array(cols)].map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded" style={{ width: `${50 + (i * 17) % 40}%` }} />
        </td>
      ))}
    </tr>
  );
}

// ── MovementBadge ─────────────────────────────────────────────────────────────
function MovementBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    stock_in:     'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400',
    stock_out:    'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400',
    transfer_in:  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-400',
    transfer_out: 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-400',
    adjustment:   'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[type] ?? 'bg-gray-100 text-gray-600'}`}>
      {MOVEMENT_LABELS[type] ?? type}
    </span>
  );
}

// ── QuickStockButton ──────────────────────────────────────────────────────────
function QuickStockButton({ row: _row, type, onNavigate }: {
  row: InventoryRow; type: 'in' | 'out'; onNavigate?: (tab: Tab) => void;
}) {
  return (
    <button
      onClick={() => onNavigate?.(type === 'in' ? 'stock-in' : 'stock-out')}
      title={type === 'in' ? 'Stock In' : 'Stock Out'}
      className={`text-xs px-1.5 py-0.5 rounded font-medium transition-colors ${
        type === 'in'
          ? 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950'
          : 'text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950'
      }`}>
      {type === 'in' ? '+ In' : '− Out'}
    </button>
  );
}

// ── Stock In Tab ──────────────────────────────────────────────────────────────
function StockInTab({ userRole, userPermissions }: { userRole?: Role; userPermissions?: string[] }) {
  const qc = useQueryClient();
  const [bookSearch, setBookSearch] = useState('');
  const [selectedRow, setSelectedRow] = useState<InventoryRow | null>(null);
  const [quantity, setQuantity] = useState('');
  const [referenceType, setReferenceType] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const { data: stockData } = useQuery<InventoryList>({
    queryKey: ['inventory', bookSearch, '', false, 1],
    queryFn: () => api.get<InventoryList>(`/inventory?q=${encodeURIComponent(bookSearch)}&pageSize=10`),
    enabled: bookSearch.length > 1,
  });

  // Fetch POs for reference dropdown when referenceType = purchase_order
  const { data: poData } = useQuery<{ items: Array<{ id: string; supplierName: string; status: string }> }>({
    queryKey: ['purchase-orders-for-ref'],
    queryFn: () => api.get('/purchase-orders?pageSize=200&status=approved'),
    enabled: referenceType === 'purchase_order',
  });

  if (!canWrite(userRole, userPermissions)) return <AccessDenied />;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedRow) { setError('Select a book and location first'); return; }
    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty <= 0) { setError('Enter a positive quantity'); return; }
    setError(''); setSaving(true); setSuccess('');
    try {
      const result = await api.post<InventoryRow>('/inventory/stock-in', {
        bookId: selectedRow.bookId,
        locationId: selectedRow.locationId,
        quantity: qty,
        version: selectedRow.version,
        referenceType: referenceType || undefined,
        referenceId: referenceId ? parseInt(referenceId, 10) : undefined,
        notes: notes || undefined,
      });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-low-stock'] });
      setSuccess(`Stock in recorded. New quantity: ${result.quantity}`);
      setSelectedRow({ ...selectedRow, quantity: result.quantity, version: result.version });
      setQuantity(''); setReferenceId(''); setNotes('');
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string };
      if (e.code === 'VERSION_CONFLICT') {
        setError('Inventory was updated by someone else. Refreshing…');
        qc.invalidateQueries({ queryKey: ['inventory'] });
      } else {
        setError(e.message ?? 'Unknown error');
      }
    } finally { setSaving(false); }
  }

  return (
    <div className="flex h-full">
      {/* Left: book selector */}
      <div className="w-80 flex-shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Select Book + Location</p>
          <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="Search books…"
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {stockData?.items.map(row => (
            <button key={`${row.bookId}-${row.locationId}`}
              onClick={() => { setSelectedRow(row); setError(''); setSuccess(''); }}
              className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${selectedRow?.bookId === row.bookId && selectedRow?.locationId === row.locationId ? 'bg-emerald-50 dark:bg-emerald-950/30' : ''}`}>
              <div className="text-sm font-medium text-gray-900 dark:text-white line-clamp-1">{row.bookTitle}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{row.locationName} · Qty: <span className={row.isLowStock ? 'text-amber-600 font-semibold' : 'font-semibold'}>{row.quantity}</span></div>
            </button>
          ))}
          {bookSearch.length <= 1 && <p className="px-4 py-3 text-xs text-gray-400 italic">Type to search books…</p>}
        </div>
      </div>

      {/* Right: form */}
      <div className="flex-1 overflow-auto flex items-start justify-center p-8">
        <div className="w-full max-w-md pb-6">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-emerald-500 text-xl">⬇️</span>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Stock In</h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">Record incoming inventory — procurement receipts, supplier deliveries, or manual additions.</p>

          {selectedRow ? (
            <div className="mb-5 p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg text-sm">
              <div className="font-medium text-emerald-900 dark:text-emerald-200">{selectedRow.bookTitle}</div>
              <div className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">{selectedRow.locationName} · Current qty: <strong>{selectedRow.quantity}</strong></div>
            </div>
          ) : (
            <div className="mb-5 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm text-gray-500 dark:text-gray-400">
              ← Select a book and location from the left panel
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">{error}</div>}
            {success && <div className="p-3 bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded-lg text-sm text-emerald-700 dark:text-emerald-300">{success}</div>}

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Quantity *</label>
              <input type="number" value={quantity} onChange={e => setQuantity(e.target.value)} min="1" placeholder="Units received"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              {selectedRow && quantity && !isNaN(parseInt(quantity, 10)) && (
                <p className="text-xs text-gray-400 mt-1">New quantity: <strong>{selectedRow.quantity + parseInt(quantity, 10)}</strong></p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reference Type</label>
                <select value={referenceType} onChange={e => { setReferenceType(e.target.value); setReferenceId(''); }}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">— None —</option>
                  <option value="purchase_order">Purchase Order</option>
                  <option value="return">Customer Return</option>
                  <option value="manual">Manual Entry</option>
                  <option value="opening_stock">Opening Stock</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {referenceType === 'purchase_order' ? 'Purchase Order' : 'Reference ID'}
                </label>
                {referenceType === 'purchase_order' ? (
                  <select value={referenceId} onChange={e => setReferenceId(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">Select PO...</option>
                    {(poData?.items ?? []).map(po => (
                      <option key={po.id} value={po.id}>PO #{po.id} — {po.supplierName}</option>
                    ))}
                  </select>
                ) : (
                  <input type="text" value={referenceId} onChange={e => setReferenceId(e.target.value)}
                    placeholder={referenceType ? 'Reference number' : '—'}
                    disabled={!referenceType}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40" />
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Additional context…"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white resize-none focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <button type="submit" disabled={saving || !selectedRow}
              className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
              {saving ? 'Recording…' : '⬇️ Record Stock In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Stock Out Tab ─────────────────────────────────────────────────────────────
function StockOutTab({ userRole, userPermissions }: { userRole?: Role; userPermissions?: string[] }) {
  const qc = useQueryClient();
  const [bookSearch, setBookSearch] = useState('');
  const [selectedRow, setSelectedRow] = useState<InventoryRow | null>(null);
  const [quantity, setQuantity] = useState('');
  const [referenceType, setReferenceType] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const { data: stockData } = useQuery<InventoryList>({
    queryKey: ['inventory', bookSearch, '', false, 1],
    queryFn: () => api.get<InventoryList>(`/inventory?q=${encodeURIComponent(bookSearch)}&pageSize=10`),
    enabled: bookSearch.length > 1,
  });

  if (!canStockOut(userRole, userPermissions)) return <AccessDenied />;

  const qty = parseInt(quantity, 10);
  const wouldGoNegative = selectedRow && !isNaN(qty) && qty > 0 && selectedRow.quantity - qty < 0;
  const wouldGoLow = selectedRow && !isNaN(qty) && qty > 0 && !wouldGoNegative && (selectedRow.quantity - qty) <= selectedRow.reorderPoint;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedRow) { setError('Select a book and location first'); return; }
    if (isNaN(qty) || qty <= 0) { setError('Enter a positive quantity'); return; }
    setError(''); setSaving(true); setSuccess('');
    try {
      const result = await api.post<InventoryRow>('/inventory/stock-out', {
        bookId: selectedRow.bookId,
        locationId: selectedRow.locationId,
        quantity: qty,
        version: selectedRow.version,
        referenceType: referenceType || undefined,
        referenceId: referenceId ? parseInt(referenceId, 10) : undefined,
        notes: notes || undefined,
      });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-low-stock'] });
      setSuccess(`Stock out recorded. New quantity: ${result.quantity}`);
      setSelectedRow({ ...selectedRow, quantity: result.quantity, version: result.version });
      setQuantity(''); setReferenceId(''); setNotes('');
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string };
      if (e.code === 'VERSION_CONFLICT') {
        setError('Inventory was updated by someone else. Refreshing…');
        qc.invalidateQueries({ queryKey: ['inventory'] });
      } else if (e.code === 'INSUFFICIENT_STOCK') {
        setError(e.message ?? 'Insufficient stock');
      } else {
        setError(e.message ?? 'Unknown error');
      }
    } finally { setSaving(false); }
  }

  return (
    <div className="flex h-full">
      {/* Left: book selector */}
      <div className="w-80 flex-shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Select Book + Location</p>
          <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="Search books…"
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {stockData?.items.map(row => (
            <button key={`${row.bookId}-${row.locationId}`}
              onClick={() => { setSelectedRow(row); setError(''); setSuccess(''); }}
              className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${selectedRow?.bookId === row.bookId && selectedRow?.locationId === row.locationId ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}>
              <div className="text-sm font-medium text-gray-900 dark:text-white line-clamp-1">{row.bookTitle}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {row.locationName} · Qty: <span className={row.isLowStock ? 'text-amber-600 font-semibold' : 'font-semibold'}>{row.quantity}</span>
                {row.isLowStock && <span className="ml-1 text-amber-500">⚠</span>}
              </div>
            </button>
          ))}
          {bookSearch.length <= 1 && <p className="px-4 py-3 text-xs text-gray-400 italic">Type to search books…</p>}
        </div>
      </div>

      {/* Right: form */}
      <div className="flex-1 overflow-auto flex items-start justify-center p-8">
        <div className="w-full max-w-md pb-6">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-blue-500 text-xl">⬆️</span>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Stock Out</h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">Record outgoing inventory — sales, order fulfillment, or manual removals.</p>

          {selectedRow ? (
            <div className="mb-5 p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
              <div className="font-medium text-blue-900 dark:text-blue-200">{selectedRow.bookTitle}</div>
              <div className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">{selectedRow.locationName} · Available: <strong>{selectedRow.quantity}</strong></div>
            </div>
          ) : (
            <div className="mb-5 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm text-gray-500 dark:text-gray-400">
              ← Select a book and location from the left panel
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">{error}</div>}
            {success && <div className="p-3 bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded-lg text-sm text-emerald-700 dark:text-emerald-300">{success}</div>}

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Quantity *</label>
              <input type="number" value={quantity} onChange={e => setQuantity(e.target.value)} min="1" placeholder="Units to remove"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              {selectedRow && !isNaN(qty) && qty > 0 && (
                <p className={`text-xs mt-1 ${wouldGoNegative ? 'text-red-500' : wouldGoLow ? 'text-amber-500' : 'text-gray-400'}`}>
                  {wouldGoNegative
                    ? `⚠ Exceeds available stock (${selectedRow.quantity})`
                    : wouldGoLow
                    ? `⚠ Will trigger low-stock alert (${selectedRow.quantity - qty} remaining)`
                    : `New quantity: ${selectedRow.quantity - qty}`}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reference Type</label>
                <select value={referenceType} onChange={e => setReferenceType(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">— None —</option>
                  <option value="sale">Sale</option>
                  <option value="order">Order</option>
                  <option value="damage">Damage Write-off</option>
                  <option value="manual">Manual Removal</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reference ID</label>
                <input type="number" value={referenceId} onChange={e => setReferenceId(e.target.value)} placeholder="e.g. Order #99"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Additional context…"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white resize-none focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <button type="submit" disabled={saving || !selectedRow || !!wouldGoNegative}
              className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
              {saving ? 'Recording…' : '⬆️ Record Stock Out'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
