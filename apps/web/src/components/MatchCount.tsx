/**
 * Under a search box's matches (#266): how many there are when more matched
 * than are shown, so nobody takes the first few for all of them.
 */
export function MatchCount({ shown, total }: { shown: number; total: number | undefined }) {
  if (total === undefined || total <= shown) return null;
  return (
    <p className="px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/60">
      {`Showing ${shown} of ${total} — keep typing to narrow`}
    </p>
  );
}
