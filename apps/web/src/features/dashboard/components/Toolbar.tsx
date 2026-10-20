import { useState } from 'react';
import { useOpenBranches } from '../../branches/queries.js';

/** The filters as typed; the page applies them once the dates are in order. */
export interface Draft { dateFrom: string; dateTo: string; groupBy: 'day' | 'week' | 'month'; branchId: string }

/** No dates, daily, and for staff with access to all branches every branch (owner decision 3a). */
export const EMPTY_DRAFT: Draft = { dateFrom: '', dateTo: '', groupBy: 'day', branchId: '' };

/**
 * Filters, Export and Refresh. Only staff with access to all branches pick a
 * branch (was: by the main role, so an Admin without it got 403s and a
 * Manager with it no picker).
 */
export function Toolbar({ draft, setDraft, problem, allBranches, kpiUpdatedAt, refreshing, onRefresh, onExport }: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  problem: string | null;
  allBranches: boolean;
  kpiUpdatedAt: number;
  refreshing: boolean;
  onRefresh: () => void;
  onExport: (type: string) => void;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const { data: branches } = useOpenBranches(allBranches);
  return (
    <>
      {/* ── Toolbar: Filters + Export + Refresh, all on one line ──
          flex-nowrap keeps Export/Refresh/"Updated" pinned in line with
          the Filters controls instead of dropping to a second row —
          the row scrolls horizontally on overflow rather than wrapping. */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-xs overflow-hidden">
        <div className="px-4 py-3 flex flex-nowrap items-center gap-2 overflow-x-auto">
          <span className="shrink-0 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Filters</span>
          <input type="date" aria-label="From" value={draft.dateFrom} onChange={e => setDraft({ ...draft, dateFrom: e.target.value })}
            className="shrink-0 px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-shadow scheme-light dark:scheme-dark" />
          <span className="shrink-0 text-xs text-gray-400">to</span>
          <input type="date" aria-label="To" aria-invalid={problem ? true : undefined} value={draft.dateTo} onChange={e => setDraft({ ...draft, dateTo: e.target.value })}
            className="shrink-0 px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-shadow scheme-light dark:scheme-dark" />
          <select aria-label="Group by" value={draft.groupBy} onChange={e => setDraft({ ...draft, groupBy: e.target.value as Draft['groupBy'] })}
            className="shrink-0 px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-shadow">
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
          {problem && <span role="alert" className="shrink-0 text-xs text-red-500">{problem}</span>}
          {/* Branch selector: staff with access to all branches (owner decision 3a: All branches first) */}
          {allBranches && (
            <select
              aria-label="Branch"
              value={draft.branchId}
              onChange={e => setDraft({ ...draft, branchId: e.target.value })}
              className="shrink-0 w-28 sm:w-36 px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-shadow truncate"
            >
              <option value="">All Branches</option>
              {(branches?.items ?? []).map(b => (
                <option key={b.id} value={String(b.id)}>{b.name}</option>
              ))}
            </select>
          )}
          <button onClick={() => setDraft(EMPTY_DRAFT)}
            className="shrink-0 px-2.5 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            Clear
          </button>

          {/* ── Export toggle + Refresh — pinned in line with Filters, never wraps ── */}
          <div className="ml-auto shrink-0 flex items-center gap-2">
            {kpiUpdatedAt > 0 && (
              <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap hidden 2xl:inline">
                Updated {new Date(kpiUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
            <button
              onClick={() => setExportOpen(o => !o)}
              aria-expanded={exportOpen}
              className={`shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border whitespace-nowrap transition-colors ${
                exportOpen
                  ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300'
                  : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
              Export
              <svg className={`w-3 h-3 transition-transform ${exportOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" /></svg>
            </button>
            <button
              onClick={onRefresh}
              disabled={refreshing}
              title="Refresh all dashboard data"
              className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-xs whitespace-nowrap transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* ── Export panel — collapsed by default to keep the toolbar compact ── */}
        {exportOpen && (
          <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/30 flex flex-wrap gap-2 items-center">
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mr-1">Export CSV</span>
            {[
              { type: 'sales', label: 'Sales' },
              { type: 'returns', label: 'Returns' },
              // 'Payments' (a thin totals-only summary) and 'Customers' (a
              // legacy top-customers export unrelated to any Prompt 2 report/
              // KPI) were dropped from this row — Payments Ledger below is the
              // canonical, transaction-level payments export.
              { type: 'payments-ledger', label: 'Payments Ledger' },
              { type: 'inventory', label: 'Inventory' },
              { type: 'inventory-valuation', label: 'Inventory Valuation' },
              { type: 'exchanges', label: 'Exchanges' },
              { type: 'procurement', label: 'Procurement' },
              { type: 'receivables', label: 'Receivables' },
              { type: 'receivables-aging', label: 'Receivables Aging' },
            ].map(({ type, label }) => (
              <button key={type} onClick={() => onExport(type)}
                className="px-2.5 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:border-blue-300 dark:hover:border-blue-700 hover:text-blue-700 dark:hover:text-blue-300 transition-colors whitespace-nowrap">
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
