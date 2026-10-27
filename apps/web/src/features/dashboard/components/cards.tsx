import type { ReactNode } from 'react';
import type { KpiPeriod } from '@bms/shared';

// The Dashboard's KPI cards, moved from the legacy page as they were.

/** An amount in short form (K, M), in the shop's currency (was: always "ETB"). */
export function shortMoney(n: number, currency: string): string {
  // A period's cash can be below zero: it gave back more than it took.
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${currency} ${sign}${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${currency} ${sign}${(a / 1_000).toFixed(1)}K`;
  return `${currency} ${sign}${a.toFixed(0)}`;
}

export function KpiCard({ label, value, sub, extra, icon, color, onClick }: {
  label: string; value: string; sub?: string; extra?: string; icon: ReactNode; color: string; onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-xs p-3 flex flex-col gap-2 min-w-0 ${onClick ? 'cursor-pointer hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-md hover:-translate-y-0.5 transition-all duration-150' : ''}`}
    >
      <div className="flex items-center gap-2">
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-base shrink-0 ${color}`}>{icon}</div>
        <p className="text-xs text-gray-500 dark:text-gray-400 font-medium leading-tight">{label}</p>
      </div>
      <p className="text-xl font-bold text-gray-900 dark:text-white leading-none pl-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 dark:text-gray-500 pl-1">{sub}</p>}
      {extra && <p className="text-xs font-medium text-blue-600 dark:text-blue-400 pl-1">{extra}</p>}
    </div>
  );
}

// ── Highlight KPI Card ────────────────────────────────────────────────────────
// Dashboard Standardization & Unified Reports Engine — Primary Row (Profit &
// Net Sales) cards. Visually distinct from KpiCard: bolder typography, a
// tinted accent background badge instead of a plain white card, so the
// bottom-line financial metrics read as top priority at a glance. Supports
// either a single `value` or a today+monthly pair (`todayValue`/`monthlyValue`,
// e.g. Net Profit) rendered side-by-side within the same card.

const HIGHLIGHT_ACCENTS: Record<'emerald' | 'teal' | 'blue' | 'rose', { card: string; badge: string }> = {
  emerald: { card: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800', badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  teal:    { card: 'bg-teal-50 dark:bg-teal-950/30 border-teal-200 dark:border-teal-800',             badge: 'bg-teal-500/15 text-teal-700 dark:text-teal-300' },
  blue:    { card: 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800',             badge: 'bg-blue-500/15 text-blue-700 dark:text-blue-300' },
  rose:    { card: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800',             badge: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' },
};

export function HighlightKpiCard({ label, value, todayValue, monthlyValue, sub, icon, accent, negative, onClick, children }: {
  label: string; value?: string; todayValue?: string; monthlyValue?: string; sub?: string;
  icon: ReactNode; accent: 'emerald' | 'teal' | 'blue' | 'rose'; negative?: boolean; onClick?: () => void;
  /** Optional trailing content next to the value — e.g. a <TrendBadge> previous-period indicator. */
  children?: ReactNode;
}) {
  const resolvedAccent = negative ? 'rose' : accent;
  const colors = HIGHLIGHT_ACCENTS[resolvedAccent];
  const valueClass = negative ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white';
  return (
    <div
      onClick={onClick}
      className={`rounded-xl border-2 shadow-xs p-4 flex flex-col gap-2 min-w-0 ${colors.card} ${onClick ? 'cursor-pointer hover:shadow-lg hover:-translate-y-0.5 transition-all duration-150' : 'transition-shadow duration-150'}`}
    >
      <div className="flex items-center gap-2">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-base shrink-0 ${colors.badge}`}>{icon}</div>
        <p className="text-xs font-bold uppercase tracking-wide text-gray-600 dark:text-gray-300 leading-tight">{label}</p>
      </div>
      {todayValue !== undefined && monthlyValue !== undefined ? (
        <div className="flex items-end gap-5 pl-1">
          <div>
            <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">Today</p>
            <p className={`text-2xl font-extrabold leading-none ${valueClass}`}>{todayValue}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">Monthly</p>
            <p className={`text-2xl font-extrabold leading-none ${valueClass}`}>{monthlyValue}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 pl-1">
          <p className={`text-2xl font-extrabold leading-none ${valueClass}`}>{value}</p>
          {children}
        </div>
      )}
      {sub && <p className="text-xs text-gray-500 dark:text-gray-400 pl-1">{sub}</p>}
    </div>
  );
}

// ── KPI color rule (Prompt 2) ─────────────────────────────────────────────────
// Single shared rule, applied consistently instead of ad-hoc per-card
// booleans: green = positive profitability, blue/gray = informational,
// amber = warning, red = critical negative only. A profitability KPI only
// ever turns red when the KPI ITSELF is negative for the period — never as
// a reaction to a single contributing event (e.g. one return) unless that
// event alone was enough to push the whole period negative. Thresholds are
// intentionally on the metric's own sign/magnitude, never on an individual
// transaction.
type KpiTone = 'positive' | 'informational' | 'warning' | 'critical';
const KPI_TONE_CLASSES: Record<KpiTone, string> = {
  positive:      'bg-emerald-100 dark:bg-emerald-900/30',
  informational: 'bg-blue-100 dark:bg-blue-900/30',
  warning:       'bg-amber-100 dark:bg-amber-900/30',
  critical:      'bg-red-100 dark:bg-red-900/30',
};
// Profitability metrics (Net Sales, Net Profit, Gross Margin %) apply this
// same rule directly via HighlightKpiCard's `negative` prop: red only when
// the KPI itself is negative for the period, never in reaction to a single
// contributing event.
/** Count/queue metrics (Low Stock, Pending Orders): amber once non-zero, never red on their own. */
export function warningCountTone(value: number): KpiTone { return value > 0 ? 'warning' : 'informational'; }
export function kpiToneClass(tone: KpiTone): string { return KPI_TONE_CLASSES[tone]; }

// ── Trend badge — previous-period % change indicator ───────────────────────

export function TrendBadge({ changePct }: { changePct: number | null }) {
  if (changePct === null) return null;
  const isUp = changePct > 0;
  const isFlat = changePct === 0;
  const color = isFlat
    ? 'text-gray-500 dark:text-gray-400'
    : isUp
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-red-600 dark:text-red-400';
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${color}`}>
      {!isFlat && (
        <svg className={`w-3 h-3 ${isUp ? '' : 'rotate-180'}`} fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clipRule="evenodd" />
        </svg>
      )}
      {Math.abs(changePct).toFixed(1)}%
    </span>
  );
}

// ── Period selector — Today / Week / Month / Year ───────────────────────────

export const PERIOD_LABELS: Record<KpiPeriod, string> = { today: 'Today', week: 'Week', month: 'Month', year: 'Year' };

export function PeriodSelector({ value, onChange }: { value: KpiPeriod; onChange: (p: KpiPeriod) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      {(Object.keys(PERIOD_LABELS) as KpiPeriod[]).map(p => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`px-2.5 py-1 text-xs font-medium transition-colors ${
            value === p
              ? 'bg-blue-600 text-white'
              : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
          }`}
        >
          {PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
  );
}
