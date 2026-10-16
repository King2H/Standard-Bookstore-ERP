import { useState } from 'react';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { useLowStock } from '../queries.js';
import { fmtDateShort } from './shared.js';

/** How many rows are at or below their reorder point, on the Low Stock tab. */
export function LowStockBadge() {
  const { data } = useLowStock({ pageSize: 1 });
  if (!data?.total) return null;
  return (
    <span className="ml-1 px-1.5 py-0.5 bg-amber-500 text-white text-xs rounded-full leading-none font-semibold">
      {data.total}
    </span>
  );
}

export function LowStockTab() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { data, isLoading, refetch } = useLowStock({ page, pageSize });

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-2 flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-amber-500 text-lg">⚠️</span>
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-white">Low Stock Alerts</p>
            <p className="text-xs text-gray-400">Books at or below their reorder point. Auto-refreshes every 60s.</p>
          </div>
        </div>
        <div className="flex-1" />
        <span className="text-xs text-gray-400">{data?.total ?? 0} items</span>
        <button type="button" onClick={() => void refetch()} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Refresh</button>
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
                {['Book', 'Location', 'Current Qty', 'Reorder At', 'Deficit', 'Last Updated'].map((h, i) => (
                  <th key={h} className={`px-4 py-3 text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide ${i >= 2 && i <= 4 ? 'text-right' : 'text-left'}`}>{h}</th>
                ))}
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
                  <td className="px-4 py-3 text-right"><span className="text-sm font-bold text-amber-600 dark:text-amber-400">{row.quantity}</span></td>
                  <td className="px-4 py-3 text-right text-sm text-gray-500 dark:text-gray-400">{row.reorderPoint}</td>
                  <td className="px-4 py-3 text-right"><span className="text-sm font-semibold text-red-600 dark:text-red-400">{row.reorderPoint - row.quantity}</span></td>
                  <td className="px-4 py-3 text-xs text-gray-400">{fmtDateShort(row.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {data && data.items.length > 0 && (
        <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)} itemLabel="low-stock item" />
      )}
    </div>
  );
}
