import { useState } from 'react';
import { type Receivable, type ReceivableSourceType, type ReceivableStatus } from '@bms/shared';
import { ActionDialog } from '../../../components/ActionDialog.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { useToast } from '../../../components/Toast.js';
import { formatCurrency } from '../../../lib/currency.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { useChangeDueDate, useReceivables, useWriteOff } from '../queries.js';
import { canCollect, canManageReceivables, isOpen, localDay, OUTSTANDING, paymentsContext } from '../rules.js';
import { DueDateDialog } from './DueDateDialog.js';

const STATUS_COLORS: Record<ReceivableStatus, string> = {
  Pending:       'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  PartiallyPaid: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
  Settled:       'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  Overdue:       'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  WrittenOff:    'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  Cancelled:     'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
};

const STATUS_LABELS: Record<ReceivableStatus, string> = {
  Pending: 'Pending', PartiallyPaid: 'Partial', Settled: 'Settled', Overdue: 'Overdue', WrittenOff: 'Written off', Cancelled: 'Cancelled',
};

const SOURCE_LABELS: Record<ReceivableSourceType, string> = {
  pos_credit_sale: 'POS Credit Sale', order_credit_sale: 'Order Credit Sale', exchange_difference: 'Exchange Diff.',
};

const SELECT = 'px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

/** Settled and written-off dates are moments, shown in the reader's own day. */
const moment = (at: string | null) => (at ? new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

/**
 * The branch's receivables. Collecting opens Payments; writing off and a new
 * due date are asked in the app's dialogs (owner decision 2a).
 */
export function ReceivableList({ initialStatus, onNavigate }: {
  initialStatus?: string;
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  const { showToast } = useToast();
  const currency = useCurrency();
  const { data: me } = useMyProfile();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [status, setStatus] = useState(initialStatus ?? '');
  const [sourceType, setSourceType] = useState<ReceivableSourceType | ''>('');
  const [writingOff, setWritingOff] = useState<Receivable | null>(null);
  const [dating, setDating] = useState<Receivable | null>(null);
  const { data, isLoading } = useReceivables({ page, pageSize, status: status || undefined, sourceType: sourceType || undefined });
  const writeOff = useWriteOff();
  const dueDate = useChangeDueDate();
  const fmt = (n: number) => formatCurrency(n, currency);
  const items = data?.items ?? [];

  function confirmWriteOff(reason?: string) {
    if (!writingOff || !reason) return;
    writeOff.mutate({ id: writingOff.id, reason }, {
      onSuccess: () => { setWritingOff(null); showToast('Receivable written off', 'success'); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  function saveDueDate(day: string | null) {
    if (!dating) return;
    dueDate.mutate({ id: dating.id, dueDate: day }, {
      onSuccess: () => { setDating(null); showToast(day ? 'Due date updated' : 'Due date removed', 'success'); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  return (
    <>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 flex flex-wrap gap-3 items-center">
        <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className={SELECT}>
          <option value="">All Statuses</option>
          <option value={OUTSTANDING}>Outstanding (Pending/Partial/Overdue)</option>
          {(Object.keys(STATUS_LABELS) as ReceivableStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <select aria-label="Type" value={sourceType} onChange={(e) => { setSourceType(e.target.value as ReceivableSourceType | ''); setPage(1); }} className={SELECT}>
          <option value="">All Types</option>
          {(Object.keys(SOURCE_LABELS) as ReceivableSourceType[]).map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
        </select>
        <div className="ml-auto text-sm text-gray-500 dark:text-gray-400">{data?.total ?? 0} records</div>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No receivables found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[800px]">
              <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  {['Customer', 'Type', 'Reference', 'Original', 'Outstanding', 'Due Date', 'Status', 'Actions'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {items.map((rec) => (
                  <tr key={rec.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900 dark:text-white">{rec.customerName ?? '—'}</p>
                      <p className="text-xs text-gray-400">{rec.customerCode ?? ''}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">{SOURCE_LABELS[rec.sourceType]}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{rec.sourceRefId}</td>
                    <td className="px-4 py-3 text-right text-gray-900 dark:text-white whitespace-nowrap">{fmt(rec.originalAmount)}</td>
                    <td className="px-4 py-3 text-right font-semibold whitespace-nowrap">
                      <span className={rec.outstandingAmount > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}>{fmt(rec.outstandingAmount)}</span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={rec.status === 'Overdue' ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-600 dark:text-gray-400'}>
                        {rec.dueDate ? localDay(rec.dueDate) : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[rec.status]}`}>{STATUS_LABELS[rec.status]}</span>
                    </td>
                    <td className="px-4 py-3">
                      {isOpen(rec.status) && (
                        <div className="flex gap-1 text-xs">
                          {canManageReceivables(me) && (
                            <button onClick={() => setDating(rec)} title="Set due date" aria-label="Set due date"
                              className="px-2 py-1 rounded-sm text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors">📅</button>
                          )}
                          {canCollect(me) && (
                            <button onClick={() => onNavigate?.('payments', paymentsContext(rec))} title="Open in Payments to collect"
                              className="px-2 py-1 rounded-sm text-green-600 hover:bg-green-50 dark:hover:bg-green-950 transition-colors">↗ Open in Payments</button>
                          )}
                          {canManageReceivables(me) && (
                            <button onClick={() => setWritingOff(rec)} title="Write off (no payment collected)"
                              className="px-2 py-1 rounded-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">✕ Write Off</button>
                          )}
                        </div>
                      )}
                      {rec.status === 'Settled' && <span className="text-xs text-gray-400">{moment(rec.settlementDate)}</span>}
                      {rec.status === 'WrittenOff' && <span className="text-xs text-gray-400" title={rec.writeOffReason ?? undefined}>{moment(rec.writtenOffAt)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <Pagination
            page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
            onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
            itemLabel="receivable"
          />
        )}
      </div>

      {writingOff && (
        <ActionDialog
          title="Write Off Receivable"
          message={`This marks ${fmt(writingOff.outstandingAmount)} of ${writingOff.sourceRefId} as uncollectible: no payment is recorded, the sale takes no further payments, and the amount is booked as a write-off. Use "Open in Payments" instead if the customer paid.`}
          confirmLabel="Write Off"
          reason={{ label: 'Why is this being written off?', max: 1000 }}
          tone="red"
          busy={writeOff.isPending}
          onConfirm={confirmWriteOff}
          onCancel={() => setWritingOff(null)}
        />
      )}
      {dating && <DueDateDialog receivable={dating} busy={dueDate.isPending} onSave={saveDueDate} onCancel={() => setDating(null)} />}
    </>
  );
}
