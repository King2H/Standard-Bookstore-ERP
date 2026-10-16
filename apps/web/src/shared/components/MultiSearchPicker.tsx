import { useState } from 'react';
import { SearchPicker, type PickerOption } from './SearchPicker.js';

/**
 * Pick several records by typing the start of their names (#95). The chosen
 * ones show as chips, each with its own remove button; a record already
 * chosen keeps its chip even when a search would no longer offer it (an
 * inactive author, say).
 */
export function MultiSearchPicker({
  value, onChange, search, queryKey, placeholder, invalid = false, className = '', 'aria-label': ariaLabel,
}: {
  value: PickerOption[];
  onChange: (options: PickerOption[]) => void;
  search: (text: string) => Promise<PickerOption[]>;
  queryKey: string;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  // A new picker after each choice, so its box empties for the next one.
  const [round, setRound] = useState(0);
  const chosen = new Set(value.map((o) => o.id));
  return (
    <div className="border border-gray-300 dark:border-gray-600 rounded-lg">
      <SearchPicker
        key={round}
        aria-label={ariaLabel}
        value={null}
        onChange={(o) => {
          if (!o) return;
          if (!chosen.has(o.id)) onChange([...value, o]);
          setRound((r) => r + 1);
        }}
        // Leaves out what is already chosen.
        search={async (q) => (await search(q)).filter((o) => !chosen.has(o.id))}
        queryKey={`${queryKey}:${[...chosen].join(',')}`}
        placeholder={placeholder}
        invalid={invalid}
        className={className}
      />
      {value.length > 0 && (
        <ul aria-label={ariaLabel ? `Chosen ${ariaLabel.toLowerCase()}` : undefined} className="px-3 py-2 border-t border-gray-200 dark:border-gray-700 flex flex-wrap gap-1">
          {value.map((o) => (
            <li key={o.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-xs rounded-full">
              {o.label}
              <button type="button" aria-label={`Remove ${o.label}`} onClick={() => onChange(value.filter((x) => x.id !== o.id))} className="hover:text-red-500 leading-none">✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
