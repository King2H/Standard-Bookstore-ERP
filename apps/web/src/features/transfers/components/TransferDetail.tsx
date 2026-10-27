import { useState } from 'react';
import type { Transfer, TransferLine } from '@bms/shared';
import { ActionDialog } from '../../../components/ActionDialog.js';
import { getCurrentBranchId } from '../../../lib/api.js';
import { formatCurrency } from '../../../lib/currency.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { canUseLocation } from '../../inventory/rules.js';
import { useLocations } from '../../locations/queries.js';
import { useCancelTransfer, useDispatchTransfer, useReceiveTransfer, useTransfer } from '../queries.js';
import { EVENT_LABELS, canChangeDraft, canReceive, canResolveLine, sideOf } from '../rules.js';
import { ResolveDialog } from './ResolveDialog.js';
import { StatusBadge } from './StatusBadge.js';
import { TransferSlip } from './TransferSlip.js';

const INPUT = 'px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white';
const CELL = 'px-3 py-2 text-right';

/**
 * One transfer note (#170): its lines and what became of them, its history,
 * and the steps the session's side may take (decisions 1a–5a).
 */
export function TransferDetail({ id, onBack, onEdit }: { id: number; onBack: () => void; onEdit: (t: Transfer) => void }) {
  const { data: t, isLoading, error } = useTransfer(id);
  const { data: me } = useMyProfile();
  const currency = useCurrency();
  const [confirm, setConfirm] = useState<'cancel' | 'dispatch' | null>(null);
  const [resolving, setResolving] = useState<TransferLine | null>(null);
  const [printing, setPrinting] = useState(false);
  const [message, setMessage] = useState('');
  const cancel = useCancelTransfer();
  const dispatch = useDispatchTransfer();

  if (isLoading) return <div className="p-6 text-sm text-gray-400">Loading…</div>;
  if (!t) return <div className="p-6 text-sm text-red-600">{(error as Error | null)?.message ?? 'Transfer not found'}</div>;

  const side = sideOf(t, getCurrentBranchId());
  const money = (n: number) => formatCurrency(n, currency);
  const step = (run: typeof cancel | typeof dispatch) => run.mutate(t.id, {
    onSuccess: () => setConfirm(null),
    onError: (err) => { setMessage((err as Error).message); setConfirm(null); },
  });

  return (
    <div className="p-6 overflow-auto h-full">
      <div className="max-w-4xl mx-auto space-y-5">
        <button type="button" onClick={onBack} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">← Back to list</button>

        <div className="flex flex-wrap items-start gap-3">
          <div>
            <h2 className="text-lg font-semibold font-mono text-gray-900 dark:text-white">{t.transferNumber}</h2>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              From {t.fromBranchName} ({t.fromLocationName}) → {t.toBranchName}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Drafted by {t.createdByName} on {new Date(t.createdAt).toLocaleString()}
              {t.dispatchedAt && ` · dispatched ${new Date(t.dispatchedAt).toLocaleString()}`}
            </p>
          </div>
          <StatusBadge status={t.status} />
          <div className="ml-auto flex flex-wrap gap-2">
            {canChangeDraft(t, side, me) && <>
              <button type="button" onClick={() => onEdit(t)} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200">Edit</button>
              <button type="button" onClick={() => setConfirm('cancel')} className="px-3 py-1.5 text-sm rounded-lg border border-red-300 text-red-600">Cancel transfer</button>
              <button type="button" onClick={() => setConfirm('dispatch')} className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white">Dispatch</button>
            </>}
            <button type="button" onClick={() => setPrinting(true)} className="px-3 py-1.5 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200">🖨 Print slip</button>
          </div>
        </div>

        {message && <div role="alert" className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">{message}</div>}
        {t.notes && <p className="text-sm text-gray-600 dark:text-gray-300">{t.notes}</p>}
        {t.inTransitValue > 0 && <p className="text-sm text-gray-700 dark:text-gray-200">In transit: <strong>{money(t.inTransitValue)}</strong> at the cost the copies left at</p>}

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 dark:text-gray-400 uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Book</th><th className={CELL}>Sent</th><th className={CELL}>Received</th><th className={CELL}>Lost</th>
                <th className={CELL}>Damaged</th><th className={CELL}>Returned</th><th className={CELL}>On the way</th><th className={CELL}>Unit cost</th><th />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {t.lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-2 text-gray-900 dark:text-white">{l.bookTitle}</td>
                  <td className={CELL}>{l.quantity}</td><td className={CELL}>{l.receivedQuantity}</td><td className={CELL}>{l.lostQuantity}</td>
                  <td className={CELL}>{l.damagedQuantity}</td><td className={CELL}>{l.returnedQuantity}</td>
                  <td className={`${CELL} font-semibold`}>{l.outstandingQuantity}</td>
                  <td className={CELL}>{l.unitCost === null ? '—' : money(l.unitCost)}</td>
                  <td className="px-3 py-2 text-right">
                    {canResolveLine(t, l, side, me) && (
                      <button type="button" aria-label={`Resolve ${l.bookTitle}`} onClick={() => setResolving(l)}
                        className="text-xs px-2 py-1 rounded border border-amber-400 text-amber-700 dark:text-amber-300">Resolve</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Starts afresh after each receipt or resolution, with what is still on the way. */}
        {canReceive(t, side, me) && <ReceivePanel key={t.events.length} transfer={t} />}

        {t.events.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">History</h3>
            <ul className="text-sm divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
              {t.events.map((e) => (
                <li key={e.id} className="px-3 py-2 flex flex-wrap gap-x-2 text-gray-700 dark:text-gray-200">
                  <span className="font-medium">{EVENT_LABELS[e.kind]}</span>
                  <span>{e.quantity} × {e.bookTitle}</span>
                  {e.locationName && <span className="text-gray-500">into {e.locationName}</span>}
                  {e.reason && <span className="text-gray-500">: {e.reason}</span>}
                  <span className="ml-auto text-xs text-gray-400">{e.staffName}, {new Date(e.createdAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {confirm === 'cancel' && (
        <ActionDialog title={`Cancel ${t.transferNumber}`} message="The draft is cancelled; no stock has moved." confirmLabel="Cancel transfer"
          tone="red" busy={cancel.isPending} onConfirm={() => step(cancel)} onCancel={() => setConfirm(null)} />
      )}
      {confirm === 'dispatch' && (
        <ActionDialog title={`Dispatch to ${t.toBranchName}`}
          message={`${t.totalQuantity} copies leave ${t.fromLocationName} now and are in transit until ${t.toBranchName} receives them.`}
          confirmLabel="Dispatch" busy={dispatch.isPending} onConfirm={() => step(dispatch)} onCancel={() => setConfirm(null)} />
      )}
      {resolving && <ResolveDialog transfer={t} line={resolving} side={side} onClose={() => setResolving(null)} />}
      {printing && <TransferSlip transfer={t} onClose={() => setPrinting(false)} />}
    </div>
  );
}

/** The receiving branch takes in what is still on the way, into one of its locations (decision 3a). */
function ReceivePanel({ transfer }: { transfer: Transfer }) {
  const { data: me } = useMyProfile();
  const { data: locationList } = useLocations(getCurrentBranchId());
  const locations = (locationList?.items ?? []).filter((l) => canUseLocation(me, l.id));
  const open = transfer.lines.filter((l) => l.outstandingQuantity > 0);
  const [quantities, setQuantities] = useState<Record<number, string>>(
    () => Object.fromEntries(open.map((l) => [l.id, String(l.outstandingQuantity)])),
  );
  const [chosen, setLocation] = useState('');
  const locationId = chosen || String(locations.find((l) => l.isDefaultFulfillment)?.id ?? locations[0]?.id ?? '');
  const [error, setError] = useState('');
  const receive = useReceiveTransfer();

  const problem = open.map((l) => {
    const v = (quantities[l.id] ?? '').trim();
    if (v === '' || v === '0') return '';
    if (!/^\d+$/.test(v)) return 'Enter a whole number';
    return Number(v) > l.outstandingQuantity ? `At most ${l.outstandingQuantity}` : '';
  });
  const items = open.map((l) => ({ lineId: l.id, quantity: Number(quantities[l.id] || 0) })).filter((i) => i.quantity > 0);

  function submit() {
    setError('');
    receive.mutate({ id: transfer.id, body: { locationId: Number(locationId), items } }, { onError: (err) => setError((err as Error).message) });
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-blue-200 dark:border-blue-800 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Receive</h3>
      <p className="text-xs text-gray-500 dark:text-gray-400">Lower a number for copies that did not arrive; an Admin or Manager resolves them.</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-2">
        <label htmlFor="receive-location" className="text-sm text-gray-700 dark:text-gray-300">Receive into</label>
        <select id="receive-location" className={INPUT} value={locationId} onChange={(e) => setLocation(e.target.value)}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
        </select>
      </div>
      <ul className="space-y-2">
        {open.map((l, i) => (
          <li key={l.id} className="flex items-center gap-3 text-sm">
            <span className="flex-1 text-gray-900 dark:text-white">{l.bookTitle} <span className="text-xs text-gray-500">({l.outstandingQuantity} on the way)</span></span>
            <input type="number" min={0} max={l.outstandingQuantity} aria-label={`Receive quantity of ${l.bookTitle}`} className={`${INPUT} w-24 text-right`}
              value={quantities[l.id] ?? ''} onChange={(e) => setQuantities((q) => ({ ...q, [l.id]: e.target.value }))}
              aria-invalid={problem[i] ? true : undefined} />
            {problem[i] && <span className="text-xs text-red-500">{problem[i]}</span>}
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <button type="button" onClick={submit} disabled={receive.isPending || !locationId || items.length === 0 || problem.some(Boolean)}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">Receive</button>
      </div>
    </div>
  );
}
