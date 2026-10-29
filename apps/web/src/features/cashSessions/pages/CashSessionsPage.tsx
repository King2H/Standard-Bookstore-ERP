import { useState } from 'react';
import type { CashSessionStatus } from '@bms/shared';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { formatCurrency } from '../../../lib/currency.js';
import { useMyProfile } from '../../account/queries.js';
import { CashReport, CashReportSlip } from '../components/CashReport.js';
import { CloseDialog, ReviewDialog } from '../components/dialogs.js';
import { useCashSession, useCashSessions } from '../queries.js';
import { canReviewCash, STATUS_LABELS, varianceLabel } from '../rules.js';

const SELECT = 'px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white';
const SECONDARY = 'px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300';
const BUTTON = 'px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white';

/**
 * The branch's cash sessions (#171, decision 2a): Admin, Manager and
 * Finance_Officer see each with its X or Z report; an Admin or Manager
 * accepts a count beyond the limit or closes a session left open. The review
 * notification opens a session here.
 */
export default function CashSessionsPage({ initialContext = {} }: { initialContext?: Record<string, string> }) {
  const [openId, setOpenId] = useState<number | null>(initialContext.sessionId ? Number(initialContext.sessionId) : null);
  const [status, setStatus] = useState<CashSessionStatus | ''>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { data, isLoading } = useCashSessions({ status: status || undefined, page, pageSize });

  if (openId !== null) return <SessionDetail id={openId} onBack={() => setOpenId(null)} />;

  return (
    <div className="p-6 space-y-4 overflow-auto h-full">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Cash Sessions</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">Each staff member's cash at the counter, from the float to the count.</p>
        </div>
        <div className="ml-auto">
          <label htmlFor="cash-status" className="sr-only">Status</label>
          <select id="cash-status" className={SELECT} value={status} onChange={(e) => { setStatus(e.target.value as CashSessionStatus | ''); setPage(1); }}>
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABELS) as CashSessionStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </div>
      </div>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 dark:text-gray-400 uppercase">
            <tr>
              <th className="px-4 py-2 text-left">Session</th><th className="px-4 py-2 text-left">Staff</th><th className="px-4 py-2 text-left">Opened</th>
              <th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-right">Counted</th><th className="px-4 py-2 text-right">Over / short</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isLoading && <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">Loading…</td></tr>}
            {data?.items.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No cash sessions.</td></tr>}
            {data?.items.map((s) => (
              <tr key={s.id} onClick={() => setOpenId(s.id)} className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="px-4 py-2 font-mono text-blue-600 dark:text-blue-400">
                  <button type="button" onClick={(e) => { e.stopPropagation(); setOpenId(s.id); }}>{s.zNumber ?? `Session ${s.id}`}</button>
                </td>
                <td className="px-4 py-2">{s.staffName}</td>
                <td className="px-4 py-2 text-gray-500">{new Date(s.openedAt).toLocaleString()}</td>
                <td className="px-4 py-2">{STATUS_LABELS[s.status]}</td>
                <td className="px-4 py-2 text-right">{s.countedCash === null ? '—' : formatCurrency(s.countedCash, s.currency)}</td>
                <td className="px-4 py-2 text-right">{s.variance === null ? '—' : varianceLabel(s.variance, (n) => formatCurrency(n, s.currency))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && (
        <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)} itemLabel="session" />
      )}
    </div>
  );
}

function SessionDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const { data: me } = useMyProfile();
  const { data: session } = useCashSession(id);
  const [dialog, setDialog] = useState<'review' | 'close' | 'print' | null>(null);
  if (!session) return <p className="p-6 text-sm text-gray-400">Loading…</p>;
  const reviewer = canReviewCash(me);
  const money = (n: number) => formatCurrency(n, session.currency);

  return (
    <div className="p-6 overflow-auto h-full">
      <div className="max-w-4xl mx-auto space-y-4">
        <button type="button" onClick={onBack} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">← Back</button>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">{session.zNumber ?? `Session ${session.id}`} · {session.staffName}</h2>
          <span className="text-sm text-gray-500">{STATUS_LABELS[session.status]}</span>
          <div className="ml-auto flex gap-2">
            <button type="button" className={SECONDARY} onClick={() => setDialog('print')}>
              {session.status === 'open' ? '🖨 Print X report' : '🖨 Print Z report'}
            </button>
            {reviewer && session.status === 'pending_review' && <button type="button" className={BUTTON} onClick={() => setDialog('review')}>Accept count</button>}
            {reviewer && session.status === 'open' && session.staffId !== me?.id && (
              <button type="button" className={BUTTON} onClick={() => setDialog('close')}>Close for {session.staffName}</button>
            )}
          </div>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Opened {new Date(session.openedAt).toLocaleString()}
          {session.closedAt && <> · closed {new Date(session.closedAt).toLocaleString()} by {session.closedByName}</>}
          {session.closeNote && <> · “{session.closeNote}”</>}
        </p>
        {session.reviewReason && (
          <p className="text-sm text-gray-600 dark:text-gray-300">Accepted by {session.reviewedByName}: {session.reviewReason}</p>
        )}
        {session.status === 'pending_review' && session.variance !== null && (
          <p className="text-sm text-amber-700 dark:text-amber-400">{varianceLabel(session.variance, money)}: beyond the branch's limit, waiting for a Manager or Admin.</p>
        )}
        <CashReport session={session} />
      </div>
      {dialog === 'print' && <CashReportSlip session={session} onClose={() => setDialog(null)} />}
      {dialog === 'review' && <ReviewDialog session={session} onClose={() => setDialog(null)} />}
      {dialog === 'close' && (
        <CloseDialog session={session} title={`Close ${session.staffName}'s session`} onClose={() => setDialog(null)} onClosed={() => setDialog(null)} />
      )}
    </div>
  );
}
