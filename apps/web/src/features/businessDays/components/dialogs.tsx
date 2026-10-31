import { useState, type FormEvent, type ReactNode } from 'react';

const BACK = 'px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300';
const GO = 'px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50';

function Dialog({ id, title, error, busy, submitLabel, disabled, onSubmit, onClose, children }: {
  id: string; title: string; error: string; busy: boolean; submitLabel: string; disabled?: boolean;
  onSubmit: () => void; onClose: () => void; children: ReactNode;
}) {
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!disabled && !busy) onSubmit();
  }
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby={id} onSubmit={submit} noValidate
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-md w-full mx-4 shadow-xl space-y-3">
        <h3 id={id} className="text-base font-semibold text-gray-900 dark:text-white">{title}</h3>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {children}
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className={BACK}>Back</button>
          <button type="submit" disabled={disabled || busy} className={GO}>{submitLabel}</button>
        </div>
      </form>
    </div>
  );
}

/** Closing a day or a month, after saying what it means (decisions 2a, 4a). */
export function CloseDialog({ what, label, explanation, onConfirm, onClose }: {
  what: string; label: string; explanation: string; onConfirm: () => Promise<unknown>; onClose: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog id="close-period-title" title={`Close ${what}?`} error={error} busy={busy} submitLabel={label} onClose={onClose}
      onSubmit={() => {
        setBusy(true);
        onConfirm().then(onClose, (e: Error) => { setError(e.message); setBusy(false); });
      }}>
      <p className="text-sm text-gray-600 dark:text-gray-300">{explanation}</p>
    </Dialog>
  );
}

/** An Admin reopens a closed day or month, saying why (decision 5a). */
export function ReopenDialog({ what, onConfirm, onClose }: { what: string; onConfirm: (reason: string) => Promise<unknown>; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = reason.trim() !== '' && reason.trim().length <= 500;
  return (
    <Dialog id="reopen-period-title" title={`Reopen ${what}?`} error={error} busy={busy} submitLabel="Reopen" disabled={!valid} onClose={onClose}
      onSubmit={() => {
        setBusy(true);
        onConfirm(reason.trim()).then(onClose, (e: Error) => { setError(e.message); setBusy(false); });
      }}>
      <p className="text-sm text-amber-700 dark:text-amber-400">
        Once reopened, records can be added again and its figures may change. Super_Admin and Finance are told.
      </p>
      <div>
        <label htmlFor="reopen-reason" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Reason</label>
        <textarea id="reopen-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
      </div>
    </Dialog>
  );
}
