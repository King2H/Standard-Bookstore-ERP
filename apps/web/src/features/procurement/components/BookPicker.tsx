import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchBooksToBuy, type BookToBuy } from '../api.js';

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const t = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(t); }, [value, delay]);
  return debounced;
}

/**
 * The book of an order line, found by typing. With a receiving location, each
 * match shows the stock already there, so the buyer sees what is on hand.
 */
export function BookPicker({ value, onChange, branchId, locationId, invalid = false }: {
  value: { bookId: number | null; bookTitle: string };
  onChange: (book: { bookId: number | null; bookTitle: string }) => void;
  branchId: number | null;
  locationId: number | null;
  invalid?: boolean;
}) {
  const [text, setText] = useState(value.bookTitle);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const typed = useDebounce(text.trim(), 300);

  useEffect(() => { setText(value.bookTitle); }, [value.bookTitle]);

  const { data: results = [], isFetching } = useQuery({
    queryKey: ['po-books', typed, branchId, locationId],
    queryFn: () => searchBooksToBuy(typed, { branchId, locationId }),
    enabled: typed.length >= 2,
    staleTime: 30_000,
  });

  useEffect(() => {
    function close(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  function choose(book: BookToBuy) {
    setText(book.title);
    setOpen(false);
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
      {open && typed.length >= 2 && (
        <ul role="listbox" className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg text-sm">
          {isFetching && <li className="px-3 py-2 text-gray-400">Searching…</li>}
          {!isFetching && results.length === 0 && <li className="px-3 py-2 text-gray-400">No books found</li>}
          {results.filter((b) => b.isActive).map((book) => (
            <li key={book.id} role="option" aria-selected={value.bookId === book.id} onMouseDown={() => choose(book)}
              className="px-3 py-2 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30 text-gray-900 dark:text-white">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{book.title}</span>
                {book.available !== null && (
                  <span className={`text-xs font-semibold shrink-0 px-1.5 py-0.5 rounded-full ${book.available === 0 ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400' : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'}`}>
                    {book.available} avail
                  </span>
                )}
              </div>
              {book.isbn && <span className="text-xs text-gray-400">{book.isbn}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
