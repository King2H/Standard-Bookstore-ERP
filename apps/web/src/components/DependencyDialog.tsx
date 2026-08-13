// Prompt 3 — Master Data Lifecycle: dependency-aware delete-blocked dialog.
// Shown when a DELETE request comes back 409 with a usage-count breakdown
// (see lib/lifecycle.ts's computeUsage on the backend) — tells the user
// exactly what's still referencing the record and offers Archive as the
// recommended next step, per the spec's example:
//
//   Cannot delete "Atomic Habits".
//   Used by:
//   - Inventory: 12 records
//   - Sales: 48 invoices
//   ...
//   Recommended action: Archive.

const USAGE_LABELS: Record<string, string> = {
  inventory: 'Inventory',
  inventoryTransactions: 'Inventory Transactions',
  sales: 'Sales',
  orders: 'Orders',
  returns: 'Returns',
  exchanges: 'Exchanges',
  purchaseOrders: 'Purchase Orders',
  books: 'Books',
};

export function DependencyDialog({ entityName, usage, onClose, onArchive, archiving }: {
  entityName: string;
  usage: Record<string, number>;
  onClose: () => void;
  /** Omit to hide the Archive shortcut (e.g. when archiving isn't offered for this entity type). */
  onArchive?: () => void;
  archiving?: boolean;
}) {
  const nonZero = Object.entries(usage).filter(([, count]) => count > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Cannot delete "{entityName}"</h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          {nonZero.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Used by</p>
              <ul className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
                {nonZero.map(([key, count]) => (
                  <li key={key} className="flex justify-between">
                    <span>{USAGE_LABELS[key] ?? key}</span>
                    <span className="font-medium">{count}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-gray-600 dark:text-gray-400">This record has historical references that prevent deletion.</p>
          )}
          <p className="text-sm text-amber-600 dark:text-amber-400 font-medium">Recommended action: Archive.</p>
        </div>
        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-800 flex gap-3">
          <button onClick={onClose} className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            Close
          </button>
          {onArchive && (
            <button onClick={onArchive} disabled={archiving}
              className="flex-1 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">
              {archiving ? 'Archiving…' : 'Archive Instead'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
