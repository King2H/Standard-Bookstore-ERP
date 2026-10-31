import { useState } from 'react';
import type { Order, OrderLineItem } from '@bms/shared';
import { useOrder } from '../queries.js';
import { deliveryProblem } from '../rules.js';

const FIELD = 'border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white';

/** A line's binding job not ready yet keeps its copies back (#169): the API refuses them. */
const jobWaiting = (l: OrderLineItem) => ['REQUESTED', 'AT_BINDER'].includes(l.service?.job?.status ?? '');

/**
 * Some of an order's copies handed over (#174, decision 1a): every line with
 * what is still waiting, prefilled; a line left at 0 is not delivered.
 */
export function DeliverDialog({ order, busy, onConfirm, onCancel }: {
  order: Pick<Order, 'id' | 'orderNumber'>;
  busy: boolean;
  onConfirm: (body: { lines: Array<{ lineId: number; quantity: number }>; notes?: string }) => void;
  onCancel: () => void;
}) {
  const { data } = useOrder(order.id);
  const waiting = (data?.lineItems ?? []).filter((l) => l.qtyReserved > 0);
  const [entered, setEntered] = useState<Record<string, string> | null>(null);
  const [notes, setNotes] = useState('');
  const [problem, setProblem] = useState('');
  const values = entered ?? Object.fromEntries(waiting.map((l) => [l.id, jobWaiting(l) ? '0' : String(l.qtyReserved)]));

  function submit() {
    const found = deliveryProblem(waiting, values);
    if (found) { setProblem(found); return; }
    setProblem('');
    const lines = waiting.filter((l) => Number(values[l.id]) > 0).map((l) => ({ lineId: Number(l.id), quantity: Number(values[l.id]) }));
    onConfirm({ lines, ...(notes.trim() && { notes: notes.trim() }) });
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div role="dialog" aria-labelledby="deliver-order-title"
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-lg w-full mx-4 shadow-xl">
        <h3 id="deliver-order-title" className="text-base font-semibold text-gray-900 dark:text-white mb-1">Deliver {order.orderNumber}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">The copies handed over now; the rest waits for a later delivery.</p>
        {!data ? <p className="text-sm text-gray-400">Loading...</p> : (
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
                <th className="pb-1 pr-2 font-medium">Book</th>
                <th className="pb-1 pr-2 font-medium text-right">Waiting</th>
                <th className="pb-1 font-medium text-right">Deliver now</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((l) => (
                <tr key={l.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="py-1.5 pr-2 text-gray-900 dark:text-white">
                    {l.bookTitle}
                    {jobWaiting(l) && <span className="block text-xs text-amber-600 dark:text-amber-400">Binding not ready yet</span>}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{l.qtyReserved}</td>
                  <td className="py-1.5 text-right">
                    <input type="text" inputMode="numeric" aria-label={`Copies of ${l.bookTitle} to deliver`} value={values[l.id] ?? ''}
                      disabled={jobWaiting(l)} onChange={(e) => setEntered({ ...values, [l.id]: e.target.value })}
                      className={`w-20 text-right ${FIELD} disabled:opacity-50`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <label htmlFor="deliver-notes" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Notes</label>
        <textarea id="deliver-notes" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} className={`w-full ${FIELD} resize-none`} />
        {problem && <p role="alert" className="text-sm text-red-600 dark:text-red-400 mt-2">{problem}</p>}
        <div className="flex gap-3 mt-5">
          <button type="button" onClick={onCancel} disabled={busy}
            className="flex-1 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50">Back</button>
          <button type="button" onClick={submit} disabled={busy || !data}
            className="flex-1 px-4 py-2 text-sm font-medium rounded-lg text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50">
            {busy ? 'Delivering…' : 'Deliver'}
          </button>
        </div>
      </div>
    </div>
  );
}
