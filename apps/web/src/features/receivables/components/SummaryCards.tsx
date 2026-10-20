import { formatCurrency } from '../../../lib/currency.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useReceivableSummary } from '../queries.js';

/** The session branch's totals: what is owed, and how much moved this month. */
export function SummaryCards({ branchId }: { branchId: number | null }) {
  const currency = useCurrency();
  const { data: summary } = useReceivableSummary(branchId);
  const cards = [
    { label: 'Total Outstanding', value: summary ? formatCurrency(summary.totalOutstanding, currency) : '—', color: 'text-red-600 dark:text-red-400' },
    { label: 'Overdue', value: summary?.overdueCount ?? '—', color: 'text-red-500 dark:text-red-400' },
    { label: 'Pending', value: summary?.pendingCount ?? '—', color: 'text-blue-600 dark:text-blue-400' },
    { label: 'Partially Paid', value: summary?.partiallyPaidCount ?? '—', color: 'text-yellow-600 dark:text-yellow-400' },
    { label: 'Settled This Month', value: summary?.settledThisMonth ?? '—', color: 'text-green-600 dark:text-green-400' },
    { label: 'Written Off This Month', value: summary?.writtenOffThisMonth ?? '—', color: 'text-gray-600 dark:text-gray-300' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{c.label}</p>
          <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
        </div>
      ))}
    </div>
  );
}
