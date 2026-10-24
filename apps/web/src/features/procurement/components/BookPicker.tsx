import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BookStockAtLocation, BookToOrder } from '@bms/shared';
import { searchBooksToOrder } from '../api.js';

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const t = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(t); }, [value, delay]);
  return debounced;
}

/** One line per location: copies on hand and, when any, on order. */
function StockLines({ stock }: { stock: BookStockAtLocation[] }) {
  if (stock.length === 0) return <span className="block text-xs text-gray-400">None on hand or on order</span>;
  return (
    <>
      {stock.map((s) => (
        <span key={s.locationId ?? 'unset'} className="block text-xs text-gray-500 dark:text-gray-400">
          {`${s.locationName ?? 'Location not chosen yet'}: ${s.onHand} on hand${s.onOrder > 0 ? ` · ${s.onOrder} on order` : ''}`}
        </span>
      ))}
    </>
  );
}

/**
 * The book of an order line, found by typing. Each match shows the stock of
 * every location of the branch (a shop and a store, say), on hand and on
 * order, and the chosen book keeps it under the field, so the buyer does not
 * order what is on the shelf or on its way.
 */
export function BookPicker({ value, onChange, branchId, branchName, invalid = false }: {
  value: { bookId: number | null; bookTitle: string };
  onChange: (book: { bookId: number | null; bookTitle: string }) => void;
  /** Whose stock to show; the session's branch when undefined. */
  branchId: number | undefined;
  branchName: string | null;
  invalid?: boolean;
}) {
  const [text, setText] = useState(value.bookTitle);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<BookToOrder | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const typed = useDebounce(text.trim(), 300);

  useEffect(() => { setText(value.bookTitle); }, [value.bookTitle]);

  const { data, isFetching } = useQuery({
    queryKey: ['po-books', typed, branchId],
    queryFn: () => searchBooksToOrder(typed, branchId),
    enabled: typed.length >= 2,
    staleTime: 30_000,
  });
  const results = data?.items ?? [];

  useEffect(() => {
    function close(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  function choose(book: BookToOrder) {
    setText(book.title);
    setOpen(false);
    setChosen(book);
    onChange({ bookId: book.id, bookTitle: book.title });
  }

  return (
    <div ref={box} className="relative">
      <input
        type="text"
        value={text}
        placeholder="Type to search books…"
        autoComplete="off"
        aria-label="Book"
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          // Typing again unsets the chosen book until another is chosen.
          if (value.bookId !== null) onChange({ bookId: null, bookTitle: e.target.value });
        }}
        onFocus={() => { if (typed.length >= 2) setOpen(true); }}
        className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500"
      />
      {chosen && value.bookId === chosen.id && !open && <div className="mt-1"><StockLines stock={chosen.stock} /></div>}
      {open && typed.length >= 2 && (
        <ul role="listbox" className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg text-sm">
          {branchName && <li className="px-3 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800">Stock at {branchName}</li>}
          {isFetching && <li className="px-3 py-2 text-gray-400">Searching…</li>}
          {!isFetching && results.length === 0 && <li className="px-3 py-2 text-gray-400">No books found</li>}
          {results.map((book) => (
            <li key={book.id} role="option" aria-selected={value.bookId === book.id} onMouseDown={() => choose(book)}
              className="px-3 py-2 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30 text-gray-900 dark:text-white">
              <span className="block font-medium">{book.title}</span>
              {book.isbn && <span className="block text-xs text-gray-400">{book.isbn}</span>}
              <StockLines stock={book.stock} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
