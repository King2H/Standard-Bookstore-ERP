import type { CashSessionDetail } from '@bms/shared';
import { PrintSlip, SlipRow } from '../../../components/PrintSlip.js';
import { formatCurrency } from '../../../lib/currency.js';
import { CATEGORY_LABELS, KIND_LABELS, METHOD_LABELS, STATUS_LABELS, varianceLabel } from '../rules.js';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * A session's X report (open) or Z report (closed) (#171, decision 3a): the
 * float, expected, counted and variance where the viewer may see them, the
 * totals by kind and method, and every movement.
 */
export function CashReport({ session }: { session: CashSessionDetail }) {
  const money = (n: number) => formatCurrency(n, session.currency);
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <Figure label="Opening float" value={money(session.openingFloat)} />
        {session.expectedCash !== null && <Figure label="Expected" value={money(session.expectedCash)} />}
        {session.countedCash !== null && <Figure label="Counted" value={money(session.countedCash)} />}
        {session.variance !== null && <Figure label="Variance" value={varianceLabel(session.variance, money)} />}
      </dl>
      {session.totals && (
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase"><tr><th className="py-1 text-left">What</th><th className="py-1 text-left">Method</th><th className="py-1 text-right">Count</th><th className="py-1 text-right">In</th><th className="py-1 text-right">Out</th></tr></thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {session.totals.length === 0 && <tr><td colSpan={5} className="py-2 text-center text-gray-400">Nothing moved yet.</td></tr>}
            {session.totals.map((t) => (
              <tr key={`${t.kind}-${t.method}-${t.direction}`}>
                <td className="py-1">{KIND_LABELS[t.kind]}</td>
                <td className="py-1">{METHOD_LABELS[t.method] ?? t.method}</td>
                <td className="py-1 text-right">{t.count}</td>
                <td className="py-1 text-right">{t.direction === 'in' ? money(t.amount) : ''}</td>
                <td className="py-1 text-right">{t.direction === 'out' ? money(t.amount) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Movements session={session} />
    </div>
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

export function Movements({ session }: { session: CashSessionDetail }) {
  if (session.movements.length === 0) return null;
  return (
    <ul className="text-sm divide-y divide-gray-100 dark:divide-gray-800">
      {session.movements.map((m) => (
        <li key={m.id} className="py-1.5 flex flex-wrap gap-x-3">
          <span className="text-gray-500">{new Date(m.createdAt).toLocaleTimeString()}</span>
          <span>{m.category ? CATEGORY_LABELS[m.category] : KIND_LABELS[m.kind]}</span>
          <span className="text-gray-500">{METHOD_LABELS[m.method] ?? m.method}</span>
          <span className={m.direction === 'in' ? 'text-green-600' : 'text-red-600'}>{m.direction === 'in' ? '+' : '−'}{formatCurrency(m.amount, session.currency)}</span>
          {m.reason && <span className="text-gray-600 dark:text-gray-300">{m.reason}</span>}
          <span className="text-gray-400">{m.staffName}</span>
        </li>
      ))}
    </ul>
  );
}

/** The X or Z report to print, with lines to sign for the count (decision 3a). */
export function CashReportSlip({ session, onClose }: { session: CashSessionDetail; onClose: () => void }) {
  const title = session.zNumber ? `Z report ${session.zNumber}` : `X report — ${session.staffName}`;
  return (
    <PrintSlip title={title} onClose={onClose}>
      <div className="space-y-1">
        <SlipRow label="Branch">{session.branchName}</SlipRow>
        <SlipRow label="Staff">{session.staffName}</SlipRow>
        <SlipRow label="Opened">{when(session.openedAt)}</SlipRow>
        <SlipRow label="Closed">{when(session.closedAt)}</SlipRow>
        <SlipRow label="Status">{STATUS_LABELS[session.status]}</SlipRow>
        {session.reviewReason && <SlipRow label="Accepted">{session.reviewedByName}: {session.reviewReason}</SlipRow>}
      </div>
      <CashReport session={session} />
      <div className="grid grid-cols-2 gap-6 pt-6 text-sm">
        <div><div className="border-b border-gray-400 h-8" /><p className="mt-1 text-gray-500">Counted by (name, signature)</p></div>
        <div><div className="border-b border-gray-400 h-8" /><p className="mt-1 text-gray-500">Checked by (name, signature)</p></div>
      </div>
    </PrintSlip>
  );
}
