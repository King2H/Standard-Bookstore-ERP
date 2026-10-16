import { MOVEMENT_LABELS } from '../rules.js';

export function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtDateShort(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="animate-pulse">
      {[...Array(cols)].map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded-sm" style={{ width: `${50 + (i * 17) % 40}%` }} />
        </td>
      ))}
    </tr>
  );
}

const MOVEMENT_STYLES: Record<string, string> = {
  stock_in: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400',
  stock_out: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400',
  transfer_in: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-400',
  transfer_out: 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-400',
  adjustment: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

export function MovementBadge({ type }: { type: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${MOVEMENT_STYLES[type] ?? 'bg-gray-100 text-gray-600'}`}>
      {MOVEMENT_LABELS[type] ?? type}
    </span>
  );
}
