import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

export interface PickerOption {
  id: number;
  label: string;
}

/**
 * Pick one record by typing the start of its name (#95). Asks the API for
 * matches instead of loading a whole list, so every record can be found
 * however many there are.
 */
export function SearchPicker({
  value, onChange, search, queryKey, placeholder = 'Type to search…', invalid = false, className = '', 'aria-label': ariaLabel,
}: {
  value: PickerOption | null;
  onChange: (option: PickerOption | null) => void;
  /** Matches for the typed text. */
  search: (text: string) => Promise<PickerOption[]>;
  /** Names the search in the query cache, e.g. 'publishers'. */
  queryKey: string;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  const listId = useId();
  const [text, setText] = useState(value?.label ?? '');
  const [open, setOpen] = useState(false);
  const typed = useDebounced(text.trim(), 250);

  useEffect(() => { setText(value?.label ?? ''); }, [value?.id, value?.label]);

  const { data: options = [], isFetching } = useQuery({
    queryKey: ['picker', queryKey, typed],
    queryFn: () => search(typed),
    enabled: open,
    staleTime: 30_000,
  });

  function choose(option: PickerOption) {
    onChange(option);
    setText(option.label);
    setOpen(false);
  }

  return (
    <div className="relative">
      <input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        value={text}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (value) onChange(null);
        }}
        // Let a click on an option land before the list closes.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={className}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg text-sm"
        >
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
        </ul>
      )}
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
