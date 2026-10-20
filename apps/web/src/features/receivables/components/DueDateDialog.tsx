import { useState } from 'react';
import type { Receivable } from '@bms/shared';

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

/**
 * Sets when a receivable is due, or removes its due date, as two distinct
 * choices (owner decision 2a; was: an inline field that removed the date when
 * saved empty). A date that has passed makes it Overdue (the API decides).
 */
export function DueDateDialog({ receivable, busy, onSave, onCancel }: {
  receivable: Receivable;
  busy: boolean;
  onSave: (dueDate: string | null) => void;
  onCancel: () => void;
}) {
  const [day, setDay] = useState(receivable.dueDate ?? '');
  const [problem, setProblem] = useState('');

  function save() {
    if (!day) { setProblem('Pick a date, or remove the due date'); return; }
    onSave(day);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="due-date-title" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl space-y-3">
        <h3 id="due-date-title" className="text-base font-semibold text-gray-900 dark:text-white">Due Date of {receivable.sourceRefId}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">A date that has passed marks it overdue.</p>
        <div>
          <label htmlFor="due-date" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Due on</label>
          <input id="due-date" type="date" value={day} onChange={(e) => { setDay(e.target.value); setProblem(''); }}
            aria-invalid={problem ? true : undefined} className={INPUT} />
          {problem && <p role="alert" className="text-xs mt-1 text-red-500">{problem}</p>}
        </div>
        <div className="flex gap-2 justify-between pt-1">
          {receivable.dueDate ? (
            <button type="button" onClick={() => onSave(null)} disabled={busy}
              className="px-3 py-2 text-sm rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50 transition-colors">Remove due date</button>
          ) : <span />}
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Back</button>
            <button type="submit" disabled={busy} className="px-4 py-2 text-sm rounded-lg text-white disabled:opacity-50 transition-colors bg-blue-600 hover:bg-blue-700">Save</button>
          </div>
        </div>
      </form>
    </div>
  );
}
