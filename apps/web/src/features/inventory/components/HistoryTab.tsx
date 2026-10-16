import { useState } from 'react';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { useStockMovements } from '../queries.js';
import { MOVEMENT_LABELS, REASON_LABELS } from '../rules.js';
import { MovementBadge, SkeletonRow, fmtDate } from './shared.js';

const FILTER = 'px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

/** Every stock movement in the session's branch, filtered by type, reason and dates. */
export function HistoryTab() {
  const [movementType, setMovementType] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const filtered = (set: (v: string) => void) => (v: string) => { set(v); setPage(1); };

  const { data, isLoading, isFetching } = useStockMovements({
    movementType: movementType || undefined, reasonCode: reasonCode || undefined,
    dateFrom: dateFrom || undefined, dateTo: dateTo || undefined, page, pageSize,
  });

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-2 flex items-center gap-3 shrink-0 flex-wrap">
        <select aria-label="Movement type" value={movementType} onChange={e => filtered(setMovementType)(e.target.value)} className={FILTER}>
          <option value="">All Types</option>
          {Object.entries(MOVEMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {/* The reasons movements are recorded with (was: also "Stock Out", never recorded, so it found nothing). */}
        <select aria-label="Reason" value={reasonCode} onChange={e => filtered(setReasonCode)(e.target.value)} className={FILTER}>
          <option value="">All Reasons</option>
          {Object.entries(REASON_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="date" aria-label="From" value={dateFrom} onChange={e => filtered(setDateFrom)(e.target.value)} className={FILTER} />
        <span className="text-xs text-gray-400">to</span>
        <input type="date" aria-label="To" value={dateTo} onChange={e => filtered(setDateTo)(e.target.value)} className={FILTER} />
        {(movementType || reasonCode || dateFrom || dateTo) && (
          <button type="button" onClick={() => { setMovementType(''); setReasonCode(''); setDateFrom(''); setDateTo(''); setPage(1); }}
            className="text-xs text-gray-400 hover:text-red-500 transition-colors">Clear</button>
        )}
        <div className="flex-1" />
        <span className="text-xs text-gray-400">{isLoading ? '…' : `${data?.total ?? 0} records`}{isFetching && !isLoading && ' ↻'}</span>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-gray-50 dark:bg-gray-800/80 sticky top-0 z-10">
            <tr>
              {['Book', 'Location', 'Before', 'Delta', 'After', 'Reason', 'By', 'When'].map((h, i) => (
                <th key={h} className={`px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide ${i >= 2 && i <= 4 ? 'text-right' : 'text-left'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
            {isLoading ? [...Array(6)].map((_, i) => <SkeletonRow key={i} cols={8} />) :
             !data?.items.length ? (
              <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400 text-sm">No history records found</td></tr>
            ) : data.items.map(h => (
              <tr key={h.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                <td className="px-4 py-3 text-sm text-gray-900 dark:text-white max-w-[180px]"><span className="line-clamp-1">{h.bookTitle}</span></td>
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
                    <span className="text-xs text-gray-600 dark:text-gray-300">{REASON_LABELS[h.reasonCode] ?? h.reasonCode}</span>
                    {h.referenceType && <span className="text-xs text-gray-400">{h.referenceType}{h.referenceId ? ` #${h.referenceId}` : ''}</span>}
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
        <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)} itemLabel="history entry" />
      )}
    </div>
  );
}
