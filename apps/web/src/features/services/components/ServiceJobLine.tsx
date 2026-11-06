import { useState } from 'react';
import { Money, type SaleServiceLine, type ServiceJobStatus } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { JOB_STATUS_LABEL, nextStep } from '../binding.js';
import { useJobStep } from '../queries.js';
import { BackAndReadyDialog } from './BackAndReadyDialog.js';

export const STATUS_CLASS: Record<ServiceJobStatus, string> = {
  REQUESTED: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  AT_BINDER: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  READY: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  COLLECTED: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400',
  CANCELLED: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400',
  RETURNED: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
};

/**
 * A book line's binding (#169 PR 2): the fee as charged and its job, which
 * whoever sells moves on. An order's ready job is collected with the order,
 * at delivery, so it offers no Collected step.
 */
export function ServiceJobLine({ line, canStep, onOrder = false, refresh }: {
  line: SaleServiceLine;
  canStep: boolean;
  onOrder?: boolean;
  /** The queries that carry the sale, refreshed after a step. */
  refresh: ReadonlyArray<readonly unknown[]>;
}) {
  const currency = useCurrency();
  const { showToast } = useToast();
  const move = useJobStep(refresh);
  const job = line.job;
  const next = job ? nextStep(job.status) : null;
  const offer = canStep && next && !(onOrder && next.step === 'collect');
  const [readying, setReadying] = useState(false);
  const run = (actualCost?: string) => {
    if (!job || !next) return;
    move.mutate({ id: job.id, step: next.step, actualCost }, {
      onSuccess: () => { showToast(`${job.jobNumber}: ${next.label.toLowerCase()}`, 'success'); setReadying(false); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
      <span>🧵 {line.serviceName} × {line.quantity}</span>
      <span className="tabular-nums">{currency} {Money.of(line.lineTotal).toFixed(2)}</span>
      {job ? (
        <>
          <span className="font-mono">{job.jobNumber}</span>
          <span className={`px-1.5 py-0.5 rounded-sm font-medium ${STATUS_CLASS[job.status]}`}>{JOB_STATUS_LABEL[job.status]}</span>
          {!['COLLECTED', 'CANCELLED', 'RETURNED'].includes(job.status) && <span>ready {job.readyDate}</span>}
          {offer && (
            <button type="button" disabled={move.isPending}
              // Back and ready asks the binder's cost first (#249).
              onClick={() => (next.step === 'ready' ? setReadying(true) : run())}
              className="px-2 py-0.5 rounded-sm border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50">
              {next.label}
            </button>
          )}
          {readying && (
            <BackAndReadyDialog jobNumber={job.jobNumber} busy={move.isPending} onConfirm={run} onCancel={() => setReadying(false)} />
          )}
        </>
      ) : (
        <span className="italic text-gray-400">job opens at confirmation</span>
      )}
    </div>
  );
}
