import { useState } from 'react';
import type { PurchaseOrder } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { paymentMethodPlainLabel } from '../../../lib/paymentMethods.js';
import { useSupplierPayables } from '../queries.js';
import { ActionDialog } from './ActionDialog.js';
import { amount } from './shared.js';

/** An order's supplier payments, with their reversal, and its credit notes. */
export function PaymentLists({ po, canPay }: { po: PurchaseOrder; canPay: boolean }) {
  const { showToast } = useToast();
  const { reverse } = useSupplierPayables(po.id);
  const [reversing, setReversing] = useState<{ id: string; number: string } | null>(null);
  const payments = po.payments ?? [];
  const creditNotes = po.creditNotes ?? [];

  return (
    <>
      {payments.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Supplier Payments</h3>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {payments.map(p => (
              <div key={p.id} className="p-4 flex items-center gap-4 text-sm">
                {p.paymentNumber && <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{p.paymentNumber}</span>}
                <span className={`font-medium text-gray-900 dark:text-white ${p.reversedAt ? 'line-through' : ''}`}>{po.currency} {amount(p.amount)}</span>
                <span className="text-gray-500 dark:text-gray-400">{paymentMethodPlainLabel(p.paymentMethod === 'bank_transfer' ? 'bank' : p.paymentMethod)}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${p.source === 'auto_on_receipt' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>
                  {p.source === 'auto_on_receipt' ? 'auto (on receipt)' : 'manual'}
                </span>
                <span className="text-gray-500 dark:text-gray-400">{new Date(p.createdAt).toLocaleString()}</span>
                {p.notes && <span className="text-gray-500 dark:text-gray-400 italic">{p.notes}</span>}
                {p.reversedAt
                  ? <span className="text-xs text-red-600 dark:text-red-400">Reversed: {p.reversalReason}</span>
                  : canPay && (
                    <button onClick={() => setReversing({ id: p.id, number: p.paymentNumber ?? `payment ${p.id}` })} disabled={reverse.isPending}
                      className="ml-auto text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950 px-2 py-1 rounded-sm transition-colors">Reverse</button>
                  )}
              </div>
            ))}
          </div>
        </div>
      )}

      {creditNotes.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Credit Notes</h3>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {creditNotes.map(cn => (
              <div key={cn.id} className="p-4 flex items-center gap-4 text-sm">
                {cn.creditNoteNumber && <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{cn.creditNoteNumber}</span>}
                <span className="font-medium text-gray-900 dark:text-white">{po.currency} {amount(cn.amount)}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">credit note</span>
                <span className="text-gray-500 dark:text-gray-400 italic">{cn.reason}</span>
                <span className="text-gray-500 dark:text-gray-400 ml-auto">{new Date(cn.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* A payment recorded by mistake is reversed, with a reason; it stays on record (owner decision 1a: the app's own dialog). */}
      {reversing && (
        <ActionDialog title={`Reverse ${reversing.number}?`} message="The payment stops counting as paid and stays on record, reversed, with the reason."
          confirmLabel="Reverse Payment" tone="red" reason={{ label: 'Why is this payment being reversed?', max: 1000 }} busy={reverse.isPending}
          onConfirm={(reason) => reverse.mutate({ paymentId: reversing.id, reason: reason! }, {
            onSuccess: () => { showToast('Payment reversed', 'success'); setReversing(null); },
            onError: (e: Error) => showToast(e.message, 'error'),
          })}
          onCancel={() => setReversing(null)} />
      )}
    </>
  );
}
