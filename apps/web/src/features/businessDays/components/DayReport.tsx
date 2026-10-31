import type { BusinessDayDetail, DayReport } from '@bms/shared';
import { PrintSlip, SlipRow } from '../../../components/PrintSlip.js';
import { formatCurrency, getCachedCurrency } from '../../../lib/currency.js';
import { METHOD_LABELS, STOCK_REASON_LABELS, varianceLabel } from '../rules.js';

const money = (n: number) => formatCurrency(n, getCachedCurrency());
const TH = 'py-1 text-left font-medium';
const THR = 'py-1 text-right font-medium';

/**
 * A branch's day report (#175, decision 2a): sales, money in and out by
 * method, returns, stock movements by reason and each cash session's count,
 * as kept when the day closed, or so far.
 */
export function DayReportView({ report }: { report: DayReport }) {
  return (
    <div className="space-y-4 text-sm">
      <Section title="Sales">
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Figure label="Orders" value={`${report.sales.orders.count} · ${money(report.sales.orders.total)}`} />
          <Figure label="POS sales" value={`${report.sales.pos.count} · ${money(report.sales.pos.total)}`} />
          <Figure label="Exchanges" value={String(report.sales.exchanges.count)} />
        </dl>
      </Section>
      <Section title="Money in and out">
        <table className="w-full">
          <thead className="text-xs text-gray-500 uppercase"><tr><th className={TH}>Method</th><th className={THR}>In</th><th className={THR}>Out</th></tr></thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {report.money.byMethod.length === 0 && <tr><td colSpan={3} className="py-2 text-center text-gray-400">No money moved.</td></tr>}
            {report.money.byMethod.map((m) => (
              <tr key={m.method}><td className="py-1">{METHOD_LABELS[m.method] ?? m.method}</td><td className="py-1 text-right">{money(m.in)}</td><td className="py-1 text-right">{money(m.out)}</td></tr>
            ))}
            <tr className="font-semibold"><td className="py-1">Total</td><td className="py-1 text-right">{money(report.money.totalIn)}</td><td className="py-1 text-right">{money(report.money.totalOut)}</td></tr>
          </tbody>
        </table>
      </Section>
      <Section title="Returns">
        <p>{report.returns.count} · refunded {money(report.returns.refunded)}</p>
      </Section>
      <Section title="Stock movements">
        <table className="w-full">
          <thead className="text-xs text-gray-500 uppercase"><tr><th className={TH}>Reason</th><th className={THR}>In</th><th className={THR}>Out</th></tr></thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {report.stock.length === 0 && <tr><td colSpan={3} className="py-2 text-center text-gray-400">No stock moved.</td></tr>}
            {report.stock.map((s) => (
              <tr key={s.reason}><td className="py-1">{STOCK_REASON_LABELS[s.reason] ?? s.reason}</td><td className="py-1 text-right">{s.in}</td><td className="py-1 text-right">{s.out}</td></tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Cash sessions">
        <table className="w-full">
          <thead className="text-xs text-gray-500 uppercase">
            <tr><th className={TH}>Session</th><th className={TH}>Staff</th><th className={THR}>Expected</th><th className={THR}>Counted</th><th className={THR}>Over / short</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {report.cash.sessions.length === 0 && <tr><td colSpan={5} className="py-2 text-center text-gray-400">No cash session.</td></tr>}
            {report.cash.sessions.map((c) => (
              <tr key={c.id}>
                <td className="py-1 font-mono">{c.zNumber ?? `Session ${c.id}`}</td><td className="py-1">{c.staffName}</td>
                <td className="py-1 text-right">{money(c.expected)}</td><td className="py-1 text-right">{money(c.counted)}</td>
                <td className="py-1 text-right">{varianceLabel(c.variance, money)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {report.cash.sessions.length > 1 && <p className="pt-1 text-right font-semibold">Total: {varianceLabel(report.cash.totalVariance, money)}</p>}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">{title}</h4>
      {children}
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="font-semibold text-gray-900 dark:text-white">{value}</dd>
    </div>
  );
}

/** The kept day report to print, with lines to sign (decision 2a). */
export function DayReportSlip({ day, onClose }: { day: BusinessDayDetail; onClose: () => void }) {
  return (
    <PrintSlip title={`Day report ${day.dayNumber}`} onClose={onClose}>
      <div className="space-y-1">
        <SlipRow label="Branch">{day.branchName}</SlipRow>
        <SlipRow label="Day">{day.day}</SlipRow>
        <SlipRow label="Closed">{new Date(day.closedAt).toLocaleString()} · {day.closedByName}</SlipRow>
      </div>
      <DayReportView report={day.report} />
      <div className="grid grid-cols-2 gap-6 pt-6 text-sm">
        <div><div className="border-b border-gray-400 h-8" /><p className="mt-1 text-gray-500">Closed by (name, signature)</p></div>
        <div><div className="border-b border-gray-400 h-8" /><p className="mt-1 text-gray-500">Checked by (name, signature)</p></div>
      </div>
    </PrintSlip>
  );
}
