// Prompt 3 — Master Data Lifecycle: reusable Active/Inactive/Archived/All
// status filter, used on every master-data page (Catalog books/authors/
// categories/publishers, Suppliers, Customers). Consolidates what used to
// be 3+ near-identical inline <select> implementations across those pages.
//
// Default is 'active' — the spec's "Default filter = Active." Callers are
// responsible for persisting the value in the URL query string (?status=)
// themselves, same pattern already used elsewhere in this app (e.g.
// CatalogPage's own filter-sync effect) rather than this component owning
// routing concerns.

export type StatusFilterValue = 'active' | 'inactive' | 'archived' | 'all';

export function StatusFilter({ value, onChange, className }: {
  value: StatusFilterValue;
  onChange: (v: StatusFilterValue) => void;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as StatusFilterValue)}
      className={className ?? 'px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500'}
    >
      <option value="active">Active</option>
      <option value="inactive">Inactive</option>
      <option value="archived">Archived</option>
      <option value="all">All</option>
    </select>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────
// ACTIVE = green, INACTIVE = amber, ARCHIVED = gray — per the spec's color rules.

export type LifecycleStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

const STATUS_BADGE_CLASSES: Record<LifecycleStatus, string> = {
  ACTIVE:   'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400',
  INACTIVE: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400',
  ARCHIVED: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
};

export function StatusBadge({ status }: { status: LifecycleStatus }) {
  // Defensive: older cached API responses / incomplete test fixtures may
  // not carry the new status field yet — fall back to ACTIVE rather than
  // crashing the row.
  const safeStatus = status ?? 'ACTIVE';
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE_CLASSES[safeStatus]}`}>
      {safeStatus.charAt(0) + safeStatus.slice(1).toLowerCase()}
    </span>
  );
}
