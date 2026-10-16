// InventoryPage — Slice 7
// Sub-pages: Stock Levels | Stock In | Stock Out | Adjust | Transfer | History | Low Stock Alerts
// Stock Levels, History and Low Stock live in features/inventory (#23); the
// stock change tabs follow in the next two PRs.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId } from '../lib/api.js';
import { useMyProfile } from '../features/account/queries.js';
import { canMoveStock } from '../features/inventory/rules.js';
import { StockLevelsTab } from '../features/inventory/components/StockLevelsTab.js';
import { HistoryTab } from '../features/inventory/components/HistoryTab.js';
import { LowStockBadge, LowStockTab } from '../features/inventory/components/LowStockTab.js';

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

const canWrite = (role: Role | undefined, perms?: string[]) =>
  (perms && perms.includes('MANAGE_INVENTORY')) ||
  role === 'Admin' || role === 'Manager' || role === 'Stock_Clerk';
// Damage and loss take stock away and a return puts it back; a correction goes either way.
type AdjustReason = 'damage' | 'loss' | 'return' | 'correction';
const FIXED_DIRECTION: Partial<Record<AdjustReason, 'add' | 'remove'>> = { damage: 'remove', loss: 'remove', return: 'add' };

export default function InventoryPage({ userRole, userPermissions, initialContext = {} }: { userRole?: Role; userPermissions?: string[]; initialContext?: Record<string, string> }) {
  const { data: me } = useMyProfile();
  const [tab, setTab] = useState<Tab>('stock');
  // The row a quick "+ In" or "− Out" was pressed on, chosen on that tab (was: ignored).
  const [chosen, setChosen] = useState<InventoryRow | null>(null);
  // Stock changes are offered only to the roles the API lets move stock (was: anyone with MANAGE_INVENTORY).
  const moves = canMoveStock(me);
  const tabs = [
    { id: 'stock' as Tab, label: 'Stock Levels', icon: '📦', show: true },
    { id: 'stock-in' as Tab, label: 'Stock In', icon: '⬇️', show: moves },
    { id: 'stock-out' as Tab, label: 'Stock Out', icon: '⬆️', show: moves },
    { id: 'adjust' as Tab, label: 'Adjust', icon: '✏️', show: moves },
    { id: 'transfer' as Tab, label: 'Transfer', icon: '↔️', show: moves },
    { id: 'history' as Tab, label: 'History', icon: '📋', show: true },
    { id: 'alerts' as Tab, label: 'Low Stock', icon: '⚠️', show: true },
  ].filter(t => t.show);
  const open = (next: Tab, row: InventoryRow | null = null) => { setChosen(row); setTab(next); };

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 flex gap-1 shrink-0">
        {tabs.map(t => (
          <button key={t.id} type="button" onClick={() => open(t.id)} aria-pressed={tab === t.id}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            <span>{t.icon}</span>{t.label}
            {t.id === 'alerts' && <LowStockBadge />}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'stock'    && <StockLevelsTab onStockIn={row => open('stock-in', row)} onStockOut={row => open('stock-out', row)} initialLowOnly={initialContext.lowStockOnly === 'true'} />}
        {tab === 'stock-in' && moves && <StockInTab key={chosen ? `${chosen.bookId}-${chosen.locationId}` : 'none'} initialRow={chosen} userRole={userRole} userPermissions={userPermissions} />}
        {tab === 'stock-out' && moves && <StockOutTab key={chosen ? `${chosen.bookId}-${chosen.locationId}` : 'none'} initialRow={chosen} userRole={userRole} userPermissions={userPermissions} />}
        {tab === 'adjust'   && moves && <AdjustTab userRole={userRole} userPermissions={userPermissions} />}
        {tab === 'transfer' && moves && <TransferTab userRole={userRole} userPermissions={userPermissions} />}
        {tab === 'history'  && <HistoryTab />}
        {tab === 'alerts'   && <LowStockTab />}
      </div>
    </div>
  );
}

// ── Adjust Tab ────────────────────────────────────────────────────────────────
function AdjustTab({ userRole, userPermissions }: { userRole?: Role; userPermissions?: string[] }) {
  const qc = useQueryClient();
  const [bookSearch, setBookSearch] = useState('');
  const [selectedBook, setSelectedBook] = useState<InventoryRow | null>(null);
  const [delta, setDelta] = useState('');
  const [reasonCode, setReasonCode] = useState<AdjustReason>('correction');
  const fixedDirection = FIXED_DIRECTION[reasonCode];

  function chooseReason(reason: AdjustReason) {
    setReasonCode(reason);
    const direction = FIXED_DIRECTION[reason];
    if (direction === 'remove') setDelta(d => d.startsWith('-') ? d : `-${d}`);
    if (direction === 'add') setDelta(d => d.replace('-', ''));
  }
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
      <div className="w-80 shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Select Book + Location</p>
          <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="Search books…"
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
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
                <button type="button" disabled={fixedDirection !== undefined} onClick={() => setDelta(d => d.startsWith('-') ? d.slice(1) : d ? `-${d}` : '-')}
                  className={`px-3 py-2 text-sm border rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${delta.startsWith('-') ? 'bg-red-100 border-red-300 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-400' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                  {delta.startsWith('-') ? '− Remove' : '+ Add'}
                </button>
                <input type="number" value={delta.replace('-', '')} onChange={e => setDelta(delta.startsWith('-') ? `-${e.target.value}` : e.target.value)}
                  min="1" placeholder="0"
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
              </div>
              {selectedBook && delta && !isNaN(parseInt(delta, 10)) && (
                <p className="text-xs text-gray-400 mt-1">
                  New quantity: <strong>{selectedBook.quantity + parseInt(delta, 10)}</strong>
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reason *</label>
              <select value={reasonCode} onChange={e => chooseReason(e.target.value as AdjustReason)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
                <option value="correction">Correction (count discrepancy)</option>
                <option value="damage">Damage</option>
                <option value="loss">Loss / Theft</option>
                <option value="return">Customer Return</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Additional context…"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white resize-none focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
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
      <div className="w-80 shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Source (Book + Location)</p>
          <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="Search books…"
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
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
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
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
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
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

// ── Stock In Tab ──────────────────────────────────────────────────────────────
function StockInTab({ userRole, userPermissions, initialRow = null }: { userRole?: Role; userPermissions?: string[]; initialRow?: InventoryRow | null }) {
  const qc = useQueryClient();
  const [bookSearch, setBookSearch] = useState('');
  const [selectedRow, setSelectedRow] = useState<InventoryRow | null>(initialRow);
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
      <div className="w-80 shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Select Book + Location</p>
          <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="Search books…"
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
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
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
              {selectedRow && quantity && !isNaN(parseInt(quantity, 10)) && (
                <p className="text-xs text-gray-400 mt-1">New quantity: <strong>{selectedRow.quantity + parseInt(quantity, 10)}</strong></p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reference Type</label>
                <select value={referenceType} onChange={e => { setReferenceType(e.target.value); setReferenceId(''); }}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
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
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
                    <option value="">Select PO...</option>
                    {(poData?.items ?? []).map(po => (
                      <option key={po.id} value={po.id}>PO #{po.id} — {po.supplierName}</option>
                    ))}
                  </select>
                ) : (
                  <input type="text" value={referenceId} onChange={e => setReferenceId(e.target.value)}
                    placeholder={referenceType ? 'Reference number' : '—'}
                    disabled={!referenceType}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 disabled:opacity-40" />
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Additional context…"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white resize-none focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
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
function StockOutTab({ userRole, userPermissions, initialRow = null }: { userRole?: Role; userPermissions?: string[]; initialRow?: InventoryRow | null }) {
  const qc = useQueryClient();
  const [bookSearch, setBookSearch] = useState('');
  const [selectedRow, setSelectedRow] = useState<InventoryRow | null>(initialRow);
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

  // Sales take stock out through POS and orders.
  if (!canWrite(userRole, userPermissions)) return <AccessDenied />;

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
      <div className="w-80 shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Select Book + Location</p>
          <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="Search books…"
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
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
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
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
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
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
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Additional context…"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white resize-none focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
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
