import { useBusinessToday } from '../queries.js';

/**
 * Across the app (#175, decision 6a): when the branch's day is closed,
 * everyone signed in to it is told before they try to record anything.
 */
export function ClosedDayBanner() {
  const { data } = useBusinessToday();
  if (data?.status !== 'closed') return null;
  return (
    <div role="status" className="bg-slate-100 dark:bg-slate-800 border-b border-slate-300 dark:border-slate-600 px-4 py-2 text-sm text-slate-800 dark:text-slate-200 flex items-center gap-2">
      <span aria-hidden="true">🔒</span>
      <span>Today ({data.day}) is closed in this branch: nothing more can be recorded until an Admin reopens it.</span>
    </div>
  );
}
