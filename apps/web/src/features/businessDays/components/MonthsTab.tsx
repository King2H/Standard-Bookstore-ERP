import { useState } from 'react';
import { getCurrentBranchId } from '../../../lib/api.js';
import { formatCurrency, getCachedCurrency } from '../../../lib/currency.js';
import { useMyProfile } from '../../account/queries.js';
import { useBusinessMonths, useCloseMonth, useMonthPreview, useReopenMonth } from '../queries.js';
import { canCloseMonth, canReopen, monthsOf, PERIOD_STATUS_LABELS, varianceLabel } from '../rules.js';
import { CloseDialog, ReopenDialog } from './dialogs.js';

const BUTTON = 'px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50';
const money = (n: number) => formatCurrency(n, getCachedCurrency());

/**
 * The shop's months of a year (#175, decisions 4a, 5a): a month closes once
 * it has ended and every branch has closed each day it worked in it.
 */
export function MonthsTab({ year, onYear, selected, onSelect, onOpenDay }: {
  year: number; onYear: (y: number) => void; selected: string | null; onSelect: (m: string) => void; onOpenDay: (day: string) => void;
}) {
  const { data } = useBusinessMonths(year);
  const status = new Map((data?.items ?? []).map((m) => [m.month, m.status]));
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label htmlFor="day-close-year" className="text-sm text-gray-600 dark:text-gray-300">Year</label>
        <input id="day-close-year" type="number" min={2000} max={2999} value={year} onChange={(e) => Number(e.target.value) >= 2000 && onYear(Number(e.target.value))}
          className="w-28 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 max-w-3xl">
        {monthsOf(year).map((m) => {
          const label = PERIOD_STATUS_LABELS[status.get(m) ?? 'open'];
          return (
            <button key={m} type="button" aria-label={`${m} ${label}`} aria-pressed={selected === m} onClick={() => onSelect(m)}
              className={`rounded-lg border border-gray-200 dark:border-gray-700 p-2 text-left text-xs ${selected === m ? 'ring-2 ring-blue-500' : ''}`}>
              <span className="block text-sm font-semibold">{m}</span>
              <span className="text-gray-500">{label}</span>
            </button>
          );
        })}
      </div>
      {selected && <MonthPanel month={selected} onOpenDay={onOpenDay} />}
    </div>
  );
}

function MonthPanel({ month, onOpenDay }: { month: string; onOpenDay: (day: string) => void }) {
  const { data: me } = useMyProfile();
  const { data: preview } = useMonthPreview(month);
  const close = useCloseMonth();
  const reopen = useReopenMonth();
  const [dialog, setDialog] = useState<'close' | 'reopen' | null>(null);
  const headingId = `month-panel-${month}`;
  const branchId = getCurrentBranchId();

  return (
    <section aria-labelledby={headingId} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={headingId} className="text-base font-semibold text-gray-900 dark:text-white">Month {month}</h2>
        {preview && <span className="text-sm text-gray-500">{PERIOD_STATUS_LABELS[preview.status]}</span>}
        {preview && (
          <div className="ml-auto flex gap-2">
            {preview.status === 'closed' && preview.businessMonthId !== null && canReopen(me) && (
              <button type="button" className={BUTTON} onClick={() => setDialog('reopen')}>Reopen</button>
            )}
            {preview.status !== 'closed' && canCloseMonth(me) && (
              <button type="button" className={BUTTON} disabled={!preview.ended || preview.openDays.length > 0} onClick={() => setDialog('close')}>Close month</button>
            )}
          </div>
        )}
      </div>
      {!preview && <p className="text-sm text-gray-400">Loading…</p>}
      {preview && !preview.ended && <p className="text-sm text-gray-500">{month} has not ended; a month closes once it has.</p>}
      {preview && preview.openDays.length > 0 && (
        <div className="text-sm text-amber-700 dark:text-amber-400 space-y-1">
          <p>Every branch closes the days it worked first:</p>
          <ul className="list-disc pl-5">
            {preview.openDays.map((b) => (
              <li key={b.branchId}>
                {b.branchId === branchId ? (
                  <>{b.branchName}:{' '}{b.days.map((d) => (
                    <button key={d} type="button" className="mr-2 underline" onClick={() => onOpenDay(d)}>{d}</button>
                  ))}</>
                ) : (
                  <span>{`${b.branchName}: ${b.days.join(', ')}`} (switch to that branch to close them)</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 uppercase">
              <tr>
                <th className="py-1 text-left">Branch</th><th className="py-1 text-right">Days closed</th><th className="py-1 text-right">Sales</th>
                <th className="py-1 text-right">Money in</th><th className="py-1 text-right">Money out</th><th className="py-1 text-right">Refunded</th>
                <th className="py-1 text-right">Cash over / short</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {preview.summary.branches.length === 0 && <tr><td colSpan={7} className="py-2 text-center text-gray-400">No day closed yet.</td></tr>}
              {preview.summary.branches.map((b) => (
                <tr key={b.branchId}>
                  <td className="py-1">{b.branchName}</td><td className="py-1 text-right">{b.days}</td><td className="py-1 text-right">{money(b.sales)}</td>
                  <td className="py-1 text-right">{money(b.moneyIn)}</td><td className="py-1 text-right">{money(b.moneyOut)}</td>
                  <td className="py-1 text-right">{money(b.refunded)}</td><td className="py-1 text-right">{varianceLabel(b.cashVariance, money)}</td>
                </tr>
              ))}
              {preview.summary.branches.length > 1 && (
                <tr className="font-semibold">
                  <td className="py-1">Shop</td><td className="py-1 text-right">{preview.summary.totals.days}</td><td className="py-1 text-right">{money(preview.summary.totals.sales)}</td>
                  <td className="py-1 text-right">{money(preview.summary.totals.moneyIn)}</td><td className="py-1 text-right">{money(preview.summary.totals.moneyOut)}</td>
                  <td className="py-1 text-right">{money(preview.summary.totals.refunded)}</td><td className="py-1 text-right">{varianceLabel(preview.summary.totals.cashVariance, money)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {dialog === 'close' && (
        <CloseDialog what={month} label="Close month" onClose={() => setDialog(null)} onConfirm={() => close.mutateAsync(month)}
          explanation="Its summary is kept and every day in it is locked, in every branch. Only an Admin can reopen it." />
      )}
      {dialog === 'reopen' && preview?.businessMonthId != null && (
        <ReopenDialog what={month} onClose={() => setDialog(null)} onConfirm={(reason) => reopen.mutateAsync({ id: preview.businessMonthId!, reason })} />
      )}
    </section>
  );
}
