import type { ReactNode } from 'react';
import { PAYMENT_METHOD_META, type PaymentMethodCode } from '../../../lib/paymentMethods.js';
import type { ReportParams } from '../api.js';

// The pieces the Dashboard's report sections share: the section frame, the
// chart tooltip and colours, and the labels for periods and payment methods.

export const PIE_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316'];

// Shared themed tooltip for all Recharts <Tooltip> instances — a dark,
// glassy card (readable in both light/dark page themes since it doesn't
// rely on Tailwind's dark: variant, which can't reach inline chart styles)
// instead of Recharts' default plain white box.
export const CHART_TOOLTIP_PROPS = {
  contentStyle: { backgroundColor: 'rgba(17,24,39,0.96)', border: 'none', borderRadius: 10, boxShadow: '0 8px 24px -4px rgba(0,0,0,0.35)', padding: '8px 12px' },
  labelStyle: { color: '#e5e7eb', fontWeight: 600, marginBottom: 4, fontSize: 11 },
  itemStyle: { color: '#f3f4f6', fontSize: 12 },
} as const;

/** Axis ticks in thousands. */
export const thousands = (v: number) => `${(v / 1000).toFixed(0)}K`;

/**
 * A period's label in the reader's calendar. Periods start with their first
 * day (YYYY-MM-DD, the database's calendar); read as that local day (was:
 * as UTC midnight, a day early west of UTC), and a month as its month.
 */
export function periodLabel(period: string, groupBy: ReportParams['groupBy']): string {
  const day = new Date(`${period.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(day.getTime())) return period;
  return groupBy === 'month'
    ? day.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** A payment method's name, as the rest of the app shows it (was: the raw code for most). */
export const methodName = (code: string) => PAYMENT_METHOD_META[code as PaymentMethodCode]?.label ?? code.replace(/_/g, ' ');

export function Section({ title, icon, children, loading, error, updatedAt, onRefresh }: {
  title: ReactNode; icon: ReactNode; children: ReactNode;
  loading?: boolean; error?: boolean;
  updatedAt?: number; onRefresh?: () => void;
}) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-xs hover:shadow-md transition-shadow duration-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">{icon}</span>
        <h2 className="text-sm font-bold text-gray-900 dark:text-white">{title}</h2>
        {/* A number, not `updatedAt && …`: before the first answer it is 0, which React prints. */}
        {updatedAt ? (
          <span className="ml-1 text-xs text-gray-400 dark:text-gray-500">
            · {new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        ) : null}
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={loading}
            title="Refresh"
            className="ml-auto p-1 rounded-md text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors disabled:opacity-40"
          >
            <svg className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        )}
      </div>
      <div className="p-4">
        {loading && <div className="h-32 flex items-center justify-center text-gray-400 text-sm">Loading...</div>}
        {error && <div className="h-32 flex items-center justify-center text-red-400 text-sm">Failed to load data</div>}
        {!loading && !error && children}
      </div>
    </div>
  );
}

export function Empty() {
  return <p className="text-center text-gray-400 text-sm py-6">No data available</p>;
}

/** A query's state as a Section takes it. */
export const sectionState = (q: { isLoading: boolean; isError: boolean; dataUpdatedAt: number; refetch: () => unknown }) => ({
  loading: q.isLoading, error: q.isError, updatedAt: q.dataUpdatedAt, onRefresh: () => { void q.refetch(); },
});
