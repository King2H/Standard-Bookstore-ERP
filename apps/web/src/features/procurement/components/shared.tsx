import { Money, type MoneyInput } from '@bms/shared';

/** An amount as the screens show it, worked out with Money (was: floating-point `toFixed`). */
export const amount = (value: MoneyInput) => Money.of(value).toFixed(2);

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  pending_approval: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  approved: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  ordered: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
  partially_received: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  received: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  closed: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
};

export const PURCHASE_ORDER_STATUSES = ['draft', 'pending_approval', 'approved', 'ordered', 'partially_received', 'received', 'closed', 'cancelled'] as const;

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-700'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

/** Clamp a fraction to [0, 1]; guards against divide-by-zero (empty PO). */
export function safePct(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) return 0;
  return Math.min(1, Math.max(0, numerator / denominator));
}

export function ProgressBar({ label, pct, tone, caption }: { label: string; pct: number; tone: 'blue' | 'green'; caption: string }) {
  const barColor = tone === 'green' ? 'bg-green-500' : 'bg-blue-500';
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="font-medium text-gray-600 dark:text-gray-400">{label}</span>
        <span className="text-gray-500 dark:text-gray-400">{caption}</span>
      </div>
      <div className="w-full h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
    </div>
  );
}
