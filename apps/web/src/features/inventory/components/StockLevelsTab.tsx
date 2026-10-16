import { useEffect, useState } from 'react';
import type { StockLevel } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { useMyProfile } from '../../account/queries.js';
import { useSetReorderPoint, useStockLevels } from '../queries.js';
import { canMoveStock, canSetReorderPoint } from '../rules.js';
import { SkeletonRow, fmtDateShort } from './shared.js';

type Status = 'active' | 'inactive' | 'all';
const TH = 'px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide';

function useDebounce<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** Stock per book and location in the session's branch, with each row's quick actions. */
export function StockLevelsTab({ onStockIn, onStockOut, initialLowOnly = false }: {
  /** Opens Stock In or Stock Out with this row chosen. */
  onStockIn: (row: StockLevel) => void;
  onStockOut: (row: StockLevel) => void;
  initialLowOnly?: boolean;
}) {
  const { showToast } = useToast();
  const { data: me } = useMyProfile();
  const canMove = canMoveStock(me);
  const canReorder = canSetReorderPoint(me);
  const hasActions = canMove || canReorder;

  const [qRaw, setQRaw] = useState('');
  // Asks once typing pauses (was: on every key).
  const q = useDebounce(qRaw.trim(), 300);
  const [lowOnly, setLowOnly] = useState(initialLowOnly);
  // Deactivated books are hidden unless asked for: they cannot be sold, reordered or restocked.
  const [status, setStatus] = useState<Status>('active');
  const [sortBy, setSortBy] = useState<'title' | 'updatedAt'>('title');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [editRow, setEditRow] = useState<StockLevel | null>(null);
  const [newReorder, setNewReorder] = useState('');
  useEffect(() => setPage(1), [q, lowOnly, status]);

  const { data, isLoading, isFetching, isError, refetch } = useStockLevels({
    q: q || undefined, lowStockOnly: lowOnly || undefined,
    is_active: status === 'active' ? 'true' : status === 'inactive' ? 'false' : 'all',
    sortBy, sortDir, page, pageSize,
  });
  const reorder = useSetReorderPoint();

  function toggleSort(col: 'title' | 'updatedAt') {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
    setPage(1);
  }

  function saveReorder(row: StockLevel) {
    // A whole number of copies, 0 or more (was: an empty box was sent as a number and refused).
    if (!/^\d+$/.test(newReorder.trim())) { showToast('Enter a whole number of copies, 0 or more', 'error'); return; }
    reorder.mutate({ bookId: row.bookId, locationId: row.locationId, reorderPoint: Number(newReorder) }, {
      onSuccess: () => { showToast('Reorder point updated', 'success'); setEditRow(null); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-2 flex items-center gap-2 shrink-0 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input value={qRaw} onChange={e => setQRaw(e.target.value)} placeholder="Search books…"
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
        </div>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
          <input type="checkbox" checked={lowOnly} onChange={e => setLowOnly(e.target.checked)} className="rounded-sm border-gray-300 dark:border-gray-600 text-amber-500" />
          Low stock only
        </label>
        <select aria-label="Book status" value={status} onChange={e => setStatus(e.target.value as Status)}
          title="Deactivated books are hidden from search and stock actions unless Inactive or All is selected"
          className="px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>
        <div className="flex-1" />
        <span className="text-xs text-gray-400">{isLoading ? '…' : `${data?.total ?? 0} records`}{isFetching && !isLoading && ' ↻'}</span>
      </div>

      {isError && (
        <div className="flex items-center justify-center gap-3 px-4 py-3 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
          <span>Failed to load inventory.</span>
          <button type="button" onClick={() => void refetch()} className="px-3 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded-sm transition-colors font-medium">Retry</button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-gray-50 dark:bg-gray-800/80 sticky top-0 z-10">
            <tr>
              <th className={`${TH} text-left`}>Book</th>
              <th className={`${TH} text-left`}>Location</th>
              <th className={`${TH} text-right`}>On Hand</th>
              <th className={`${TH} text-right`}>Reserved</th>
              <th className={`${TH} text-right`}>Available</th>
              <th className={`${TH} text-right`}>Reorder At</th>
              <th className={`${TH} text-center`}>Status</th>
              <th className="px-4 py-3 text-left" aria-sort={sortBy === 'updatedAt' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
                <button type="button" onClick={() => toggleSort('updatedAt')}
                  className={`flex items-center gap-1 text-xs font-semibold uppercase tracking-wide transition-colors ${sortBy === 'updatedAt' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                  Updated <span className="text-xs">{sortBy === 'updatedAt' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
                </button>
              </th>
              {hasActions && <th className={`${TH} text-right`}>Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
            {isLoading ? [...Array(6)].map((_, i) => <SkeletonRow key={i} cols={hasActions ? 9 : 8} />) :
             !data?.items.length ? (
              <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-400 text-sm">No inventory records found</td></tr>
            ) : data.items.map(row => (
              // `group` lets the row's actions brighten on hover (was: missing, so they stayed faded).
              <tr key={`${row.bookId}-${row.locationId}`} className={`group hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors ${row.isLowStock ? 'bg-amber-50/50 dark:bg-amber-950/20' : ''}`}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <div className="font-medium text-gray-900 dark:text-white text-sm line-clamp-1">{row.bookTitle}</div>
                    {!row.bookIsActive && (
                      <span className="shrink-0 text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 rounded-full font-medium">Inactive</span>
                    )}
                  </div>
                  <div className="text-xs font-mono text-gray-400">{row.bookIsbn}</div>
                </td>
                <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{row.locationName}</td>
                <td className="px-4 py-3 text-right">
                  <span className={`text-sm font-semibold ${row.isLowStock ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-white'}`}>{row.quantity}</span>
                </td>
                <td className="px-4 py-3 text-right text-sm text-gray-400 dark:text-gray-500">{row.reserved}</td>
                <td className="px-4 py-3 text-right">
                  <span className={`text-sm font-semibold ${row.available === 0 ? 'text-red-500 dark:text-red-400' : row.isLowStock ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{row.available}</span>
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
                {hasActions && (
                  <td className="px-4 py-3 text-right">
                    {editRow?.bookId === row.bookId && editRow?.locationId === row.locationId ? (
                      <div className="flex items-center gap-1 justify-end">
                        <input type="number" aria-label="Reorder point" value={newReorder} onChange={e => setNewReorder(e.target.value)} min="0" step="1"
                          className="w-16 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                        <button type="button" aria-label="Save reorder point" disabled={reorder.isPending} onClick={() => saveReorder(row)}
                          className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-sm transition-colors disabled:opacity-50">✓</button>
                        <button type="button" aria-label="Cancel" onClick={() => setEditRow(null)} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">✕</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 justify-end opacity-40 group-hover:opacity-100 transition-opacity">
                        {canMove && (
                          <>
                            <button type="button" title="Stock In" onClick={() => onStockIn(row)}
                              className="text-xs px-1.5 py-0.5 rounded font-medium transition-colors text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950">+ In</button>
                            <button type="button" title="Stock Out" onClick={() => onStockOut(row)}
                              className="text-xs px-1.5 py-0.5 rounded font-medium transition-colors text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950">− Out</button>
                          </>
                        )}
                        {canReorder && (
                          <button type="button" title="Reorder point" onClick={() => { setEditRow(row); setNewReorder(String(row.reorderPoint)); }}
                            className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">⚙</button>
                        )}
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
        <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)} itemLabel="inventory record" />
      )}
    </div>
  );
}
