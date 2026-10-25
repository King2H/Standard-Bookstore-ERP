import { Money, type SaleServiceLine } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { JOB_STATUS_LABEL, nextStep } from '../binding.js';
import { useJobStep } from '../queries.js';

const STATUS_CLASS: Record<string, string> = {
  REQUESTED: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  AT_BINDER: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  READY: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  COLLECTED: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400',
  CANCELLED: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400',
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

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
      <span>🧵 {line.serviceName} × {line.quantity}</span>
      <span className="tabular-nums">{currency} {Money.of(line.lineTotal).toFixed(2)}</span>
      {job ? (
        <>
          <span className="font-mono">{job.jobNumber}</span>
          <span className={`px-1.5 py-0.5 rounded-sm font-medium ${STATUS_CLASS[job.status]}`}>{JOB_STATUS_LABEL[job.status]}</span>
          {!['COLLECTED', 'CANCELLED'].includes(job.status) && <span>ready {job.readyDate}</span>}
          {offer && (
            <button type="button" disabled={move.isPending}
              onClick={() => move.mutate({ id: job.id, step: next.step }, {
                onSuccess: () => showToast(`${job.jobNumber}: ${next.label.toLowerCase()}`, 'success'),
                onError: (e: Error) => showToast(e.message, 'error'),
              })}
              className="px-2 py-0.5 rounded-sm border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50">
              {next.label}
            </button>
          )}
        </>
      ) : (
        <span className="italic text-gray-400">job opens at confirmation</span>
      )}
    </div>
  );
}
