import { useState } from 'react';
import type { SupplierReturnDetail } from '@bms/shared';
import { ActionDialog } from '../../../components/ActionDialog.js';
import { useToast } from '../../../components/Toast.js';
import { formatCurrency } from '../../../lib/currency.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { useCancelSupplierReturn, useSendSupplierReturn, useSupplierReturn } from '../queries.js';
import { canDraft, canSend } from '../rules.js';
import { ReturnNote } from './ReturnNote.js';
import { StatusBadge } from './StatusBadge.js';

const CELL = 'px-3 py-2 text-right';
const BTN = 'px-4 py-2 text-sm font-medium rounded-lg disabled:opacity-50 transition-colors';

/**
 * One return to supplier (#173): its lines at the order's price and, once
 * sent, at their cost with the gain or loss; a draft is edited, cancelled
 * with a reason, or sent after a confirmation (decision 3a).
 */
export function ReturnDetail({ id, onBack, onEdit, onOpenOrder }: {
  id: number;
  onBack: () => void;
  onEdit: (r: SupplierReturnDetail) => void;
  onOpenOrder: (poId: string) => void;
}) {
  const { data: r, isLoading, error } = useSupplierReturn(id);
  const { data: me } = useMyProfile();
  const currency = useCurrency();
  const { showToast } = useToast();
  const [confirm, setConfirm] = useState<'send' | 'cancel' | null>(null);
  const [printing, setPrinting] = useState(false);
  const send = useSendSupplierReturn();
  const cancel = useCancelSupplierReturn();

  if (isLoading) return <div className="p-6 text-sm text-gray-400">Loading…</div>;
  if (!r) return <div className="p-6 text-sm text-red-600">{(error as Error | null)?.message ?? 'Return not found'}</div>;

  const money = (n: number) => formatCurrency(n, currency);
  const draft = r.status === 'draft';
  const sent = r.status === 'sent';
  const failed = (e: unknown) => { showToast((e as Error).message, 'error'); setConfirm(null); };

  return (
    <div className="p-6 overflow-auto h-full">
      <div className="max-w-4xl mx-auto space-y-5">
        <button type="button" onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back</button>
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white"><span className="font-mono">{r.returnNumber}</span> · {r.supplierName}</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Order <button type="button" onClick={() => onOpenOrder(r.poId)} className="text-blue-600 dark:text-blue-400 hover:underline">{r.poNumber}</button>
              {' '}· drafted by {r.createdByName} on {new Date(r.createdAt).toLocaleString()}
              {r.sentAt && ` · sent by ${r.sentByName} on ${new Date(r.sentAt).toLocaleString()}`}
            </p>
            {r.notes && <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">{r.notes}</p>}
            {r.cancelReason && <p className="text-sm text-red-600 dark:text-red-400 mt-1">Cancelled: {r.cancelReason}</p>}
            {r.creditNoteNumber && <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">Credit note {r.creditNoteNumber}</p>}
          </div>
          <StatusBadge status={r.status} />
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 dark:text-gray-400 uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Book</th>
                <th className="px-3 py-2 text-left">Location</th>
                <th className="px-3 py-2 text-left">From</th>
                <th className={CELL}>Qty</th>
                <th className={CELL}>Price</th>
                <th className={CELL}>Credit</th>
                {sent && <th className={CELL}>Unit Cost</th>}
                {sent && <th className={CELL}>Cost</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {r.lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-2 text-gray-900 dark:text-white">{l.bookTitle}</td>
                  <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{l.locationName}</td>
                  <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{l.source === 'damaged' ? 'Damaged' : 'Stock'}</td>
                  <td className={CELL}>{l.quantity}</td>
                  <td className={CELL}>{money(l.unitCredit)}</td>
                  <td className={CELL}>{money(l.creditValue)}</td>
                  {sent && <td className={CELL}>{l.unitCost === null ? '—' : money(l.unitCost)}</td>}
                  {sent && <td className={CELL}>{l.costValue === null ? '—' : money(l.costValue)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap gap-6 text-sm text-gray-700 dark:text-gray-200">
          <span>Credit {money(r.creditValue)}</span>
          {r.costValue !== null && <span>Cost {money(r.costValue)}</span>}
          {r.gainLoss !== null && (
            <span className={r.gainLoss < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}>
              {r.gainLoss > 0 ? `Gain ${money(r.gainLoss)}` : r.gainLoss < 0 ? `Loss ${money(-r.gainLoss)}` : 'No gain or loss'}
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2 justify-end">
          {r.status !== 'cancelled' && <button type="button" onClick={() => setPrinting(true)} className={`${BTN} border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200`}>🖨 Print Return Note</button>}
          {draft && canDraft(me, r.branchId) && (
            <>
              <button type="button" onClick={() => onEdit(r)} className={`${BTN} bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300`}>Edit</button>
              <button type="button" onClick={() => setConfirm('cancel')} className={`${BTN} bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300`}>Cancel Return</button>
            </>
          )}
          {draft && canSend(me, r.branchId) && (
            <button type="button" onClick={() => setConfirm('send')} className={`${BTN} bg-blue-600 hover:bg-blue-700 text-white`}>Send to Supplier</button>
          )}
        </div>
      </div>

      {confirm === 'send' && (
        <ActionDialog title={`Send ${r.returnNumber}?`} confirmLabel="Send" busy={send.isPending}
          message={`${r.totalQuantity} copies leave; the order is credited ${money(r.creditValue)}. A sent return cannot be undone.`}
          onConfirm={() => send.mutate(r.id, { onSuccess: () => { showToast('Return sent', 'success'); setConfirm(null); }, onError: failed })}
          onCancel={() => setConfirm(null)} />
      )}
      {confirm === 'cancel' && (
        <ActionDialog title={`Cancel ${r.returnNumber}?`} confirmLabel="Cancel Return" tone="red" busy={cancel.isPending}
          message="Nothing has moved; the draft is kept, cancelled." reason={{ label: 'Reason', max: 500 }}
          onConfirm={(reason) => cancel.mutate({ id: r.id, reason: reason ?? '' }, { onSuccess: () => { showToast('Return cancelled', 'success'); setConfirm(null); }, onError: failed })}
          onCancel={() => setConfirm(null)} />
      )}
      {printing && <ReturnNote r={r} onClose={() => setPrinting(false)} />}
    </div>
  );
}
