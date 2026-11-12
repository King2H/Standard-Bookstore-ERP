import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { PickerOption, PickerPage } from '../picker.js';

export { PICKER_PAGE_SIZE, pickerPage, type PickerOption, type PickerPage } from '../picker.js';

/**
 * Pick one record by typing part of its name (#95). Asks the API for matches
 * a page at a time instead of loading a whole list, says how many there are,
 * and shows more on request or as the list scrolls, so every record can be
 * found however many there are (#266).
 */
export function SearchPicker({
  value, onChange, search, queryKey, placeholder = 'Type to search…', invalid = false, className = '', 'aria-label': ariaLabel, id, floating = true, browse = false,
}: {
  value: PickerOption | null;
  onChange: (option: PickerOption | null) => void;
  /** A page (from 1) of the records matching the typed text. */
  search: (text: string, page: number) => Promise<PickerPage>;
  /** Names the search in the query cache, e.g. 'publishers'. */
  queryKey: string;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
  'aria-label'?: string;
  id?: string;
  /**
   * Draws the list over the page (the default), so no table, dialog or toolbar
   * that scrolls or clips can hide it; false keeps it in the page's flow.
   */
  floating?: boolean;
  /** Nothing to type: the list opens on a click and pages like any other. */
  browse?: boolean;
}) {
  const listId = useId();
  const [text, setText] = useState(value?.label ?? '');
  const [open, setOpen] = useState(false);
  const typed = useDebounced(text.trim(), 250);
  const inputRef = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});

  // A floating list follows its box: under it, as wide, wherever the page scrolls.
  useLayoutEffect(() => {
    if (!floating || !open) return;
    const follow = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (r) setPlace({ position: 'fixed', top: r.bottom + 4, left: r.left, width: Math.max(r.width, 224) });
    };
    follow();
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => { window.removeEventListener('scroll', follow, true); window.removeEventListener('resize', follow); };
  }, [floating, open]);

  // The box shows the choice when it changes from outside; letting a choice go by
  // typing over it keeps what was typed (was: the box emptied).
  const lettingGo = useRef(false);
  useEffect(() => {
    if (lettingGo.current && value === null) { lettingGo.current = false; return; }
    lettingGo.current = false;
    setText(value?.label ?? '');
  }, [value?.id, value?.label]);

  const { data, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['picker', queryKey, typed],
    queryFn: ({ pageParam }) => search(typed, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => {
      const shown = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && shown < last.total ? pages.length + 1 : undefined;
    },
    enabled: open,
    staleTime: 30_000,
  });
  const options = data?.pages.flatMap((p) => p.items) ?? [];
  const total = data?.pages[data.pages.length - 1]?.total ?? 0;
  const more = () => { if (hasNextPage && !isFetchingNextPage) void fetchNextPage(); };

  function choose(option: PickerOption) {
    onChange(option);
    setText(option.label);
    setOpen(false);
  }

  const list = (
    <div
      style={floating ? place : undefined}
      className={`${floating ? 'z-50' : 'absolute z-10 mt-1 w-full'} max-h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg text-sm`}
      // The next page as the list nears its end.
      onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) more();
      }}
    >
      <ul id={listId} role="listbox">
        {options.map((o) => (
          <li
            key={o.id}
            role="option"
            aria-selected={value?.id === o.id}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(o)}
            className="px-3 py-2 cursor-pointer text-gray-900 dark:text-white hover:bg-blue-50 dark:hover:bg-blue-950/40"
          >
            {o.label}
          </li>
        ))}
        {options.length === 0 && (
          <li className="px-3 py-2 text-gray-400">{isFetching ? 'Searching…' : 'No matches'}</li>
        )}
        {options.length > 0 && (
          <li className="px-3 py-1.5 flex items-center justify-between gap-2 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
            <span>{`Showing ${options.length} of ${total}`}</span>
            {hasNextPage && (
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={more} disabled={isFetchingNextPage}
                className="text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50">
                {isFetchingNextPage ? 'Loading…' : 'Show more'}
              </button>
            )}
          </li>
        )}
      </ul>
    </div>
  );

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        value={text}
        readOnly={browse}
        onClick={() => setOpen(true)}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (value) { lettingGo.current = true; onChange(null); }
        }}
        // Let a click on an option land before the list closes.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={className}
      />
      {open && (floating ? createPortal(list, document.body) : list)}
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
