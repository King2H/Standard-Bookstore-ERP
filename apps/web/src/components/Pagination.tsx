// ── Pagination ────────────────────────────────────────────────────────────────
// Shared pagination control used across all paginated list/history tables in
// the app (Pagination & Layout Standardization initiative). One component,
// one visual style, one behavior — no page should hand-roll its own
// Prev/Next buttons or page-size logic.
//
// Purely presentational: it owns no state. The page passes the current
// page/pageSize/total (usually straight from the API's { page, pageSize,
// total, totalPages } response shape, already used everywhere in this app)
// and receives onPageChange/onPageSizeChange callbacks to update its own
// state and refetch. Changing the page size resets to page 1 (the caller's
// onPageSizeChange is expected to do this — see usage below).

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** Singular/plural noun for the "records" label, e.g. "order", "customer". Defaults to "record". */
  itemLabel?: string;
  /** Override the default [10, 25, 50, 100] option list. */
  pageSizeOptions?: readonly number[];
}

function PageBtn({ onClick, disabled, label, title }: { onClick: () => void; disabled: boolean; label: string; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="px-2.5 py-1.5 text-xs font-medium border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      {label}
    </button>
  );
}

export default function Pagination({
  page, pageSize, total, totalPages,
  onPageChange, onPageSizeChange,
  itemLabel = 'record',
  pageSizeOptions = PAGE_SIZE_OPTIONS,
}: PaginationProps) {
  const safeTotalPages = Math.max(1, totalPages);
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-gray-200 dark:border-gray-800 text-sm">
      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
        <span>
          {total === 0
            ? `No ${itemLabel}s found`
            : `Showing ${rangeStart}–${rangeEnd} of ${total} ${itemLabel}${total === 1 ? '' : 's'}`}
        </span>
        <label className="flex items-center gap-1.5">
          <span className="hidden sm:inline">Rows:</span>
          <select
            value={pageSize}
            onChange={e => onPageSizeChange(Number(e.target.value))}
            className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {pageSizeOptions.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
          Page {page} of {safeTotalPages}
        </span>
        <div className="flex gap-1">
          <PageBtn title="First page" label="« First" onClick={() => onPageChange(1)} disabled={page <= 1} />
          <PageBtn title="Previous page" label="‹ Prev" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1} />
          <PageBtn title="Next page" label="Next ›" onClick={() => onPageChange(Math.min(safeTotalPages, page + 1))} disabled={page >= safeTotalPages} />
          <PageBtn title="Last page" label="Last »" onClick={() => onPageChange(safeTotalPages)} disabled={page >= safeTotalPages} />
        </div>
      </div>
    </div>
  );
}

/**
 * Shared hook-free helper: builds the (page, pageSize) → onPageSizeChange
 * handler that every page needs (change page size, reset to page 1). Kept
 * here so the "reset to page 1 on size change" rule lives in exactly one
 * place instead of being repeated at every call site.
 */
export function makePageSizeHandler(setPage: (p: number) => void, setPageSize: (n: number) => void) {
  return (n: number) => { setPageSize(n); setPage(1); };
}
