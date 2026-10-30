import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listStockLevels } from '../../inventory/api.js';
import { INPUT, LABEL } from '../../inventory/components/stockChange.js';
import { inventoryKeys } from '../../inventory/queries.js';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Finds books held at a location by title or ISBN, for a count (#172, decision 4a); books already chosen are left out. */
export function BookFinder({ locationId, exclude, onAdd }: {
  locationId: number | null;
  exclude: number[];
  onAdd: (book: { bookId: number; title: string; isbn: string | null }) => void;
}) {
  const [term, setTerm] = useState('');
  const typed = useDebounced(term.trim(), 250);
  const params = { q: typed, locationId: locationId ?? undefined, pageSize: 10 };
  const search = useQuery({ queryKey: inventoryKeys.levels(params), queryFn: () => listStockLevels(params), enabled: typed.length > 1 && locationId !== null });
  const results = (search.data?.items ?? []).filter((r) => !exclude.includes(r.bookId));
  return (
    <div>
      <label htmlFor="count-find" className={LABEL}>Find a book</label>
      <input id="count-find" type="text" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Title or ISBN" className={INPUT} />
      {term.trim().length > 1 && typed.length > 1 && (
        <ul className="mt-1 border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
          {results.length === 0 && !search.isFetching && <li className="px-3 py-2 text-xs text-gray-400">No book found.</li>}
          {results.map((r) => (
            <li key={r.bookId}>
              <button type="button" onClick={() => { onAdd({ bookId: r.bookId, title: r.bookTitle, isbn: r.bookIsbn }); setTerm(''); }}
                className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-800">Add {r.bookTitle}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
