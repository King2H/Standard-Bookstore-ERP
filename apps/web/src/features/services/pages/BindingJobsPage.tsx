import { useEffect, useState } from 'react';
import { ServiceJobStatusSchema, type ServiceJobBoardItem, type ServiceJobStatus } from '@bms/shared';
import { ActionDialog } from '../../../components/ActionDialog.js';
import Pagination, { makePageSizeHandler } from '../../../components/Pagination.js';
import { useToast } from '../../../components/Toast.js';
import { useMyProfile } from '../../account/queries.js';
import { JOB_STATUS_LABEL, nextStep } from '../binding.js';
import { STATUS_CLASS } from '../components/ServiceJobLine.js';
import { serviceJobKeys, useCancelBinding, useJobStep, useServiceJobs } from '../queries.js';
import { canCancelBinding } from '../rules.js';

const TH = 'px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide text-left';
const REFRESH = [serviceJobKeys.all];
const SOURCE_LABEL: Record<ServiceJobBoardItem['source'], string> = { POS: 'Counter sale', ORDER: 'Order', EXCHANGE: 'Exchange' };

function useDebounce<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/**
 * The binding jobs board (#169 PR 3, owner decision 1a): the session
 * branch's jobs, the oldest ready date first, with the customer's phone to
 * call when one is ready. Whoever sells moves a job on; an order's ready job
 * is collected with the order, at delivery. A Manager or Admin cancels a
 * binding still Requested, with a reason, and its fee goes back (3a).
 */
export default function BindingJobsPage() {
  const { showToast } = useToast();
  const { data: me } = useMyProfile();
  const canCancel = canCancelBinding(me);
  const [searchRaw, setSearchRaw] = useState('');
  const q = useDebounce(searchRaw.trim(), 300);
  const [status, setStatus] = useState<ServiceJobStatus | ''>('');
  const [overdue, setOverdue] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [cancelling, setCancelling] = useState<ServiceJobBoardItem | null>(null);
  useEffect(() => setPage(1), [q, status, overdue]);

  const { data, isLoading } = useServiceJobs({
    status: status || undefined, overdue: overdue ? 'true' : undefined, q: q || undefined, page, pageSize,
  });
  const move = useJobStep(REFRESH);
  const cancel = useCancelBinding(REFRESH);

  function step(job: ServiceJobBoardItem) {
    const next = nextStep(job.status);
    if (!next) return;
    move.mutate({ id: job.id, step: next.step }, {
      onSuccess: () => showToast(`${job.jobNumber}: ${next.label.toLowerCase()}`, 'success'),
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  function confirmCancel(reason?: string) {
    if (!cancelling || !reason) return;
    const job = cancelling;
    cancel.mutate({ id: job.id, reason }, {
      onSuccess: () => { showToast(`${job.jobNumber}: binding cancelled, fee given back`, 'success'); setCancelling(null); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  const columns = ['Job', 'Book', 'Binding', 'Customer', 'Sale', 'Ready', 'Status', ''];

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 py-3 flex flex-wrap items-center gap-4 shrink-0">
        <span className="text-lg">🧵</span>
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Binding Jobs</h2>
          {data && <p className="text-xs text-gray-400">{data.total} {data.total === 1 ? 'job' : 'jobs'}</p>}
        </div>
        <div className="flex-1 max-w-xs">
          <input value={searchRaw} onChange={(e) => setSearchRaw(e.target.value)} placeholder="Job number or customer…"
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as ServiceJobStatus | '')}
            className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
            <option value="">All</option>
            {ServiceJobStatusSchema.options.map((s) => <option key={s} value={s}>{JOB_STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} className="rounded-sm border-gray-300 dark:border-gray-600" />
          Overdue only
        </label>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-gray-50 dark:bg-gray-800/80 sticky top-0 z-10">
            <tr>{columns.map((c, i) => <th key={i} className={TH}>{c}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
            {isLoading ? (
              <tr><td colSpan={columns.length} className="px-4 py-12 text-center text-gray-400 text-sm">Loading…</td></tr>
            ) : !data?.items.length ? (
              <tr><td colSpan={columns.length} className="px-4 py-12 text-center text-gray-400 text-sm">No binding jobs found</td></tr>
            ) : data.items.map((job) => {
              const next = nextStep(job.status);
              // An order's bound copies go with the order: delivering it collects the job.
              const withDelivery = job.source === 'ORDER' && next?.step === 'collect';
              return (
                <tr key={job.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{job.jobNumber}</td>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{job.bookTitle}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{`${job.serviceName} × ${job.quantity}`}</td>
                  <td className="px-4 py-3">
                    <div className="text-gray-900 dark:text-white">{job.customerName}</div>
                    {job.customerPhone
                      ? <a href={`tel:${job.customerPhone}`} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">{job.customerPhone}</a>
                      : <span className="text-xs italic text-gray-400">no phone</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs text-gray-600 dark:text-gray-400">{job.saleNumber}</div>
                    <div className="text-xs text-gray-400">{SOURCE_LABEL[job.source]}</div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="text-gray-600 dark:text-gray-400">{job.readyDate}</div>
                    {job.overdue && <span className="text-xs font-medium text-red-600 dark:text-red-400">Overdue</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-1.5 py-0.5 rounded-sm text-xs font-medium ${STATUS_CLASS[job.status]}`}>{JOB_STATUS_LABEL[job.status]}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex gap-3 justify-end items-center">
                      {next && (withDelivery
                        ? <span className="text-xs italic text-gray-400">goes with the order</span>
                        : <button type="button" disabled={move.isPending} onClick={() => step(job)}
                            className="px-2 py-0.5 text-xs rounded-sm border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50">
                            {next.label}
                          </button>)}
                      {canCancel && job.status === 'REQUESTED' && (
                        <button type="button" onClick={() => setCancelling(job)} className="text-xs text-red-600 dark:text-red-400 hover:underline">Cancel binding</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data && (
        <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)} itemLabel="job" />
      )}
      {cancelling && (
        <ActionDialog
          title={`Cancel binding ${cancelling.jobNumber}`}
          message={`${cancelling.serviceName} × ${cancelling.quantity} on ${cancelling.saleNumber}. The fee goes back the way it was paid; the book stays sold, unbound.`}
          confirmLabel="Cancel binding"
          reason={{ label: 'Reason', max: 500 }}
          busy={cancel.isPending}
          tone="red"
          onConfirm={confirmCancel}
          onCancel={() => setCancelling(null)}
        />
      )}
    </div>
  );
}
