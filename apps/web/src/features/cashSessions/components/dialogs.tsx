import { useState, type FormEvent, type ReactNode } from 'react';
import type { CashMovementCategory, CashSessionDetail } from '@bms/shared';
import { useAddCashMovement, useCloseCashSession, useReviewCashSession } from '../queries.js';
import { CATEGORY_LABELS, categoriesFor, isCashAmount } from '../rules.js';

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white';
const LABEL = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

function Dialog({ title, error, busy, submitLabel, disabled, onSubmit, onClose, children }: {
  title: string; error: string; busy: boolean; submitLabel: string; disabled?: boolean;
  onSubmit: () => void; onClose: () => void; children: ReactNode;
}) {
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!disabled && !busy) onSubmit();
  }
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="cash-dialog-title" onSubmit={submit} noValidate
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl space-y-3">
        <h3 id="cash-dialog-title" className="text-base font-semibold text-gray-900 dark:text-white">{title}</h3>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {children}
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">Back</button>
          <button type="submit" disabled={disabled || busy} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">{submitLabel}</button>
        </div>
      </form>
    </div>
  );
}

/**
 * Cash put in or taken out of one's own open session (#171, decision 3a):
 * a type that fits the direction, an amount and a reason.
 */
export function MovementDialog({ session, onClose }: { session: CashSessionDetail; onClose: () => void }) {
  const [direction, setDirection] = useState<'in' | 'out'>('out');
  const [category, setCategory] = useState<CashMovementCategory>(categoriesFor('out')[0]);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const add = useAddCashMovement();
  const valid = isCashAmount(amount.trim()) && Number(amount) > 0 && reason.trim() !== '' && reason.trim().length <= 500;

  function chooseDirection(d: 'in' | 'out') {
    setDirection(d);
    setCategory(categoriesFor(d)[0]);
  }

  return (
    <Dialog title="Cash in / out" error={error} busy={add.isPending} submitLabel="Save" disabled={!valid} onClose={onClose}
      onSubmit={() => add.mutate({ id: session.id, body: { direction, category, amount: amount.trim(), reason: reason.trim() } },
        { onSuccess: onClose, onError: (e) => setError((e as Error).message) })}>
      <div>
        <label htmlFor="cash-direction" className={LABEL}>Direction</label>
        <select id="cash-direction" className={INPUT} value={direction} onChange={(e) => chooseDirection(e.target.value as 'in' | 'out')}>
          <option value="out">Take out</option>
          <option value="in">Put in</option>
        </select>
      </div>
      <div>
        <label htmlFor="cash-category" className={LABEL}>Type</label>
        <select id="cash-category" className={INPUT} value={category} onChange={(e) => setCategory(e.target.value as CashMovementCategory)}>
          {categoriesFor(direction).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="cash-amount" className={LABEL}>Amount</label>
        <input id="cash-amount" inputMode="decimal" className={INPUT} value={amount} onChange={(e) => setAmount(e.target.value)} />
        {direction === 'out' && <p className="text-xs mt-1 text-gray-500">Never more than the drawer holds.</p>}
      </div>
      <div>
        <label htmlFor="cash-reason" className={LABEL}>Reason</label>
        <textarea id="cash-reason" rows={2} maxLength={500} className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}

/**
 * The count at close (#171, decision 4a): blind, so nothing here says what is
 * expected. A Manager or Admin closes a session its staff member left open.
 */
export function CloseDialog({ session, title, onClose, onClosed }: {
  session: CashSessionDetail; title: string; onClose: () => void; onClosed: (closed: CashSessionDetail) => void;
}) {
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const close = useCloseCashSession();
  return (
    <Dialog title={title} error={error} busy={close.isPending} submitLabel="Close session" disabled={!isCashAmount(counted.trim())} onClose={onClose}
      onSubmit={() => close.mutate({ id: session.id, body: { countedCash: counted.trim(), note: note.trim() || null } },
        { onSuccess: onClosed, onError: (e) => setError((e as Error).message) })}>
      <p className="text-sm text-gray-500 dark:text-gray-400">Count the cash in the drawer and enter the total.</p>
      <div>
        <label htmlFor="cash-counted" className={LABEL}>Cash counted</label>
        <input id="cash-counted" inputMode="decimal" className={INPUT} value={counted} onChange={(e) => setCounted(e.target.value)} />
      </div>
      <div>
        <label htmlFor="cash-note" className={LABEL}>Note</label>
        <textarea id="cash-note" rows={2} maxLength={1000} className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Dialog>
  );
}

/** An Admin or Manager accepts a count beyond the branch's limit, saying why (#171, decision 4a). */
export function ReviewDialog({ session, onClose }: { session: CashSessionDetail; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const review = useReviewCashSession();
  return (
    <Dialog title={`Accept ${session.zNumber ?? 'count'}`} error={error} busy={review.isPending} submitLabel="Accept"
      disabled={!reason.trim() || reason.trim().length > 500} onClose={onClose}
      onSubmit={() => review.mutate({ id: session.id, reason: reason.trim() }, { onSuccess: onClose, onError: (e) => setError((e as Error).message) })}>
      <div>
        <label htmlFor="cash-review-reason" className={LABEL}>Reason</label>
        <textarea id="cash-review-reason" rows={3} maxLength={500} className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}
