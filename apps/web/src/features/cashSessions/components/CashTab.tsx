import { useState } from 'react';
import type { CashSessionDetail } from '@bms/shared';
import { formatCurrency } from '../../../lib/currency.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useCurrentCashSession, useOpenCashSession } from '../queries.js';
import { isCashAmount, varianceLabel, STATUS_LABELS } from '../rules.js';
import { CashReport, CashReportSlip } from './CashReport.js';
import { CloseDialog, MovementDialog } from './dialogs.js';

const INPUT = 'w-40 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white';
const BUTTON = 'px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50';
const SECONDARY = 'px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300';

/** The branch takes cash only with an open session (decision 6a of the API). */
export const REQUIRED_NOTICE = 'This branch takes cash only with an open cash session.';

/**
 * The cashier's own cash session on the POS page (#171, decision 1a): opened
 * with a float, cash put in or taken out, and closed with a blind count, its
 * Z report printed. What is expected stays hidden while it is open.
 */
export function CashTab() {
  const currency = useCurrency();
  const { data, isLoading } = useCurrentCashSession();
  const session = data?.session ?? null;
  const [float, setFloat] = useState('');
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'move' | 'close' | null>(null);
  const [closed, setClosed] = useState<CashSessionDetail | null>(null);
  const [printing, setPrinting] = useState(false);
  const open = useOpenCashSession();

  function openSession() {
    setError('');
    open.mutate({ openingFloat: float.trim() }, { onSuccess: () => setFloat(''), onError: (e) => setError((e as Error).message) });
  }

  return (
    <div className="p-6 overflow-auto flex-1">
      <div className="max-w-3xl mx-auto space-y-5">
        {closed && (
          <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">{closed.zNumber}</h2>
              <span className="text-sm text-gray-500">{STATUS_LABELS[closed.status]}</span>
              {closed.variance !== null && <span className="text-sm font-medium">{varianceLabel(closed.variance, (n) => formatCurrency(n, closed.currency))}</span>}
              <div className="ml-auto flex gap-2">
                <button type="button" className={SECONDARY} onClick={() => setPrinting(true)}>🖨 Print Z report</button>
                <button type="button" className={SECONDARY} onClick={() => setClosed(null)}>Done</button>
              </div>
            </div>
            {closed.status === 'pending_review' && (
              <p className="text-sm text-amber-700 dark:text-amber-400">Over or short beyond the branch's limit: a Manager or Admin accepts it.</p>
            )}
            <CashReport session={closed} />
          </section>
        )}

        {isLoading ? <p className="text-sm text-gray-400">Loading…</p> : session === null ? (
          <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 space-y-3">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">No cash session open</h2>
            {data?.required && <p className="text-sm text-amber-700 dark:text-amber-400">{REQUIRED_NOTICE}</p>}
            <p className="text-sm text-gray-500 dark:text-gray-400">Count the cash in the drawer to start; 0 when it starts empty.</p>
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <div className="flex items-end gap-2">
              <div>
                <label htmlFor="cash-float" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Opening float</label>
                <input id="cash-float" inputMode="decimal" className={INPUT} value={float} onChange={(e) => setFloat(e.target.value)} placeholder={`${currency} 0.00`} />
              </div>
              <button type="button" className={BUTTON} disabled={!isCashAmount(float.trim()) || open.isPending} onClick={openSession}>Open session</button>
            </div>
          </section>
        ) : (
          <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-base font-semibold text-green-700 dark:text-green-400">Session open</h2>
              <span className="text-sm text-gray-500">since {new Date(session.openedAt).toLocaleString()}</span>
              <div className="ml-auto flex gap-2">
                <button type="button" className={SECONDARY} onClick={() => setDialog('move')}>Cash in / out</button>
                <button type="button" className={BUTTON} onClick={() => setDialog('close')}>Close session</button>
              </div>
            </div>
            <CashReport session={session} />
          </section>
        )}
      </div>

      {dialog === 'move' && session && <MovementDialog session={session} onClose={() => setDialog(null)} />}
      {dialog === 'close' && session && (
        <CloseDialog session={session} title="Count the cash" onClose={() => setDialog(null)}
          onClosed={(s) => { setDialog(null); setClosed(s); }} />
      )}
      {printing && closed && <CashReportSlip session={closed} onClose={() => setPrinting(false)} />}
    </div>
  );
}
