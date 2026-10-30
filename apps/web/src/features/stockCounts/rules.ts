import type { ProfileResponse, StockCountStatus } from '@bms/shared';

/** Who may do what with a stock count: the API's rules (stockCounts.routes.ts), any role held in the session branch (#172). */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Opening and counting: Admin, Manager and Stock_Clerk. */
export const canCount = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Stock_Clerk']);

/** Reviewing, recounting, posting and cancelling: Admin and Manager (APPROVE_STOCK_COUNT). */
export const canReview = (me: Account | undefined) => holds(me, ['Admin', 'Manager']);

export const STATUS_LABELS: Record<StockCountStatus, string> = {
  counting: 'Counting', submitted: 'Waiting for review', posted: 'Posted', cancelled: 'Cancelled',
};

export const STATUS_CLASSES: Record<StockCountStatus, string> = {
  counting: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  submitted: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  posted: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  cancelled: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

/** Counted quantities as typed: whole numbers from 0. */
export const isCount = (v: string) => /^\d+$/.test(v);
