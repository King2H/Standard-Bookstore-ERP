import { useState } from 'react';
import { Money, type PurchaseOrder } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useMyProfile } from '../../account/queries.js';
import { usePurchaseOrder, usePurchaseOrderStep } from '../queries.js';
import { approvalNote, canReadLedger, stepsFor } from '../rules.js';
import { ActionDialog } from '../../../components/ActionDialog.js';
import { PaymentForms } from './PaymentForms.js';
import { PaymentLists } from './PaymentLists.js';
import { RefundForm } from './RefundForm.js';
import { useSupplierReturns } from '../../supplierReturns/queries.js';
import { canReturnOrder } from '../../supplierReturns/rules.js';
import { StatusBadge as ReturnStatusBadge } from '../../supplierReturns/components/StatusBadge.js';
import { ProgressBar, StatusBadge, amount, safePct } from './shared.js';

type Asking = 'cancel' | 'closeShort' | null;

const BTN = 'px-4 py-2 text-sm font-medium rounded-lg disabled:opacity-50 transition-colors';

/** One purchase order: its figures, the steps this staff member may take, its lines and receipts. */
export function PurchaseOrderDetail({ poId, onBack, onEdit, onReceive, onLedger, onReturn, onOpenReturn }: {
  poId: string;
  onBack: () => void;
  onEdit: (po: PurchaseOrder) => void;
  onReceive: (po: PurchaseOrder) => void;
  onLedger: (supplierId: number, supplierName: string) => void;
  /** Starts a return of the order's books to the supplier (#173). */
  onReturn: (po: PurchaseOrder) => void;
  onOpenReturn: (id: number) => void;
}) {
  const { showToast } = useToast();
  const { data: me } = useMyProfile();
  const { data: po, isLoading } = usePurchaseOrder(poId);
  const step = usePurchaseOrderStep(poId);
  const [asking, setAsking] = useState<Asking>(null);
  const { data: returns } = useSupplierReturns({ poId: Number(poId), pageSize: 100 });

  if (isLoading) return <div className="p-8 text-center text-gray-400">Loading...</div>;
  if (!po) return <div className="p-8 text-center text-gray-400">PO not found.</div>;

  // Offered as the API allows: roles held and the ordering or receiving branch.
  const steps = stepsFor(po, me);
  const run = (s: Parameters<typeof step.mutate>[0], done: string, after?: () => void) =>
    step.mutate(s, {
      onSuccess: () => { showToast(done, 'success'); setAsking(null); after?.(); },
      onError: (e: Error) => showToast(e.message, 'error'),
    });

  const note = approvalNote(po);
  const receivingPct = safePct(po.receivedQuantityTotal, po.orderedQuantityTotal);
  const settled = Money.of(po.amountPaid).plus(po.creditNotesTotal);
  const paymentPct = safePct(settled.toNumber(), po.receivedValue);

  return (
    <div className="p-6 space-y-5 max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back to List</button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{po.poNumber}</h2>
        <StatusBadge status={po.status} />
        {canReadLedger(me) && (
          <button onClick={() => onLedger(po.supplierId, po.supplierName)} className="ml-auto text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline">
            View Supplier Ledger →
          </button>
        )}
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 grid grid-cols-2 gap-4 text-sm">
        <div><span className="text-gray-500 dark:text-gray-400">Supplier:</span> <span className="font-medium text-gray-900 dark:text-white ml-1">{po.supplierName}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">Total:</span> <span className="font-medium text-gray-900 dark:text-white ml-1">{po.currency} {amount(po.totalAmount)}</span></div>
        {po.closedReason && <div><span className="text-gray-500 dark:text-gray-400">Closed short:</span> <span className="text-gray-900 dark:text-white ml-1">{po.closedReason}</span></div>}
        {note && <div className="col-span-2"><span className="text-gray-500 dark:text-gray-400">Approval:</span> <span className="text-gray-900 dark:text-white ml-1">{note}</span></div>}
        <div><span className="text-gray-500 dark:text-gray-400">Expected Delivery:</span> <span className="font-medium text-gray-900 dark:text-white ml-1">{po.expectedDeliveryDate ?? '—'}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">Created:</span> <span className="font-medium text-gray-900 dark:text-white ml-1">{new Date(po.createdAt).toLocaleDateString()}</span></div>
        {po.receivingLocationName && (
          <div>
            <span className="text-gray-500 dark:text-gray-400">Receiving Location:</span>
            <span className="font-medium text-gray-900 dark:text-white ml-1">{po.receivingLocationName}</span>
          </div>
        )}
        <div>
          <span className="text-gray-500 dark:text-gray-400">Payment Status:</span>
          <span className={`ml-1 text-xs font-medium px-2 py-0.5 rounded-full ${po.financialStatus === 'paid' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : po.financialStatus === 'partial' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
            {po.financialStatus}
          </span>
          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">({po.paymentTerms === 'cash' ? 'Cash — settles on receipt' : 'Credit'})</span>
        </div>
        {po.notes && <div className="col-span-2"><span className="text-gray-500 dark:text-gray-400">Notes:</span> <span className="text-gray-900 dark:text-white ml-1">{po.notes}</span></div>}
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ProgressBar label="Receiving Progress" pct={receivingPct} tone="blue" caption={`${po.receivedQuantityTotal} / ${po.orderedQuantityTotal} units`} />
          <ProgressBar label="Payment Progress" pct={paymentPct} tone="green" caption={`${po.currency} ${amount(settled)} / ${amount(po.receivedValue)}`} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs pt-1 border-t border-gray-100 dark:border-gray-800">
          <div className="pt-3"><div className="text-gray-500 dark:text-gray-400">Received Value</div><div className="font-semibold text-gray-900 dark:text-white">{po.currency} {amount(po.receivedValue)}</div></div>
          <div className="pt-3"><div className="text-gray-500 dark:text-gray-400">Amount Paid</div><div className="font-semibold text-gray-900 dark:text-white">{po.currency} {amount(po.amountPaid)}</div></div>
          <div className="pt-3"><div className="text-gray-500 dark:text-gray-400">Credit Notes</div><div className="font-semibold text-gray-900 dark:text-white">{po.currency} {amount(po.creditNotesTotal)}</div></div>
          {po.refundsTotal > 0 && <div className="pt-3"><div className="text-gray-500 dark:text-gray-400">Refunds Received</div><div className="font-semibold text-gray-900 dark:text-white">{po.currency} {amount(po.refundsTotal)}</div></div>}
          {po.refundDue > 0 && <div className="pt-3"><div className="text-gray-500 dark:text-gray-400">Refund Due</div><div className="font-semibold text-teal-700 dark:text-teal-400">{po.currency} {amount(po.refundDue)}</div></div>}
          <div className="pt-3"><div className="text-gray-500 dark:text-gray-400">Outstanding</div><div className={`font-semibold ${po.outstandingAmount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-white'}`}>{po.currency} {amount(po.outstandingAmount)}</div></div>
        </div>
      </div>

      {/* Once the order is a commitment and something is still owed. */}
      {steps.pay && po.financialStatus !== 'paid' && !['draft', 'pending_approval', 'cancelled'].includes(po.status) && <PaymentForms po={po} />}
      {/* Returns credited beyond what the order owed: the supplier pays back (#173, decision 4a). */}
      {steps.pay && po.refundDue > 0 && <RefundForm po={po} />}

      <div className="flex flex-wrap gap-2">
        {steps.edit && <button onClick={() => onEdit(po)} className={`${BTN} bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700`}>Edit</button>}
        {steps.submit && <button onClick={() => run({ action: 'submit' }, 'Submitted for approval')} disabled={step.isPending} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`}>Submit for Approval</button>}
        {steps.approve && <button onClick={() => run({ action: 'approve' }, 'PO approved')} disabled={step.isPending} className={`${BTN} bg-green-600 text-white hover:bg-green-700`}>Approve</button>}
        {steps.order && <button onClick={() => run({ action: 'order' }, 'Marked as ordered')} disabled={step.isPending} className={`${BTN} bg-indigo-600 text-white hover:bg-indigo-700`}>Mark as Ordered</button>}
        {steps.receive && <button onClick={() => onReceive(po)} className={`${BTN} bg-green-600 text-white hover:bg-green-700`}>{po.status === 'partially_received' ? 'Receive More Goods' : 'Receive Goods'}</button>}
        {steps.closeShort && <button onClick={() => setAsking('closeShort')} disabled={step.isPending} className={`${BTN} bg-teal-100 dark:bg-teal-900 text-teal-700 dark:text-teal-300 hover:bg-teal-200 dark:hover:bg-teal-800`}>Close Short</button>}
        {steps.close && <button onClick={() => run({ action: 'close' }, 'PO closed')} disabled={step.isPending} className={`${BTN} bg-teal-600 text-white hover:bg-teal-700`}>Close PO</button>}
        {canReturnOrder(po, me) && <button onClick={() => onReturn(po)} className={`${BTN} bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 hover:bg-orange-200 dark:hover:bg-orange-800`}>Return to Supplier</button>}
        {steps.cancel && <button onClick={() => setAsking('cancel')} disabled={step.isPending} className={`${BTN} bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-800`}>Cancel</button>}
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Line Items</h3>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>{['Book', 'ISBN', 'Ordered', 'Received', 'Returned', 'Remaining', 'Unit Cost', 'Line Total'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {(po.lineItems ?? []).map(li => (
              <tr key={li.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="px-4 py-3 text-gray-900 dark:text-white">{li.bookTitle}</td>
                <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">{li.bookIsbn}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.quantity}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.receivedQuantity}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.returnedQuantity}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.remaining}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{amount(li.unitCost)}</td>
                <td className="px-4 py-3 text-gray-900 dark:text-white font-medium">{amount(Money.of(li.unitCost).times(li.quantity))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(po.receipts ?? []).length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Receipts (GRNs)</h3>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {(po.receipts ?? []).map(r => (
              <div key={r.id} className="p-4 space-y-2">
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-medium text-gray-900 dark:text-white">Receipt #{r.id}</span>
                  <span className="text-gray-500 dark:text-gray-400">{r.locationName}</span>
                  <span className="text-gray-500 dark:text-gray-400">{new Date(r.receivedAt).toLocaleString()}</span>
                  {r.notes && <span className="text-gray-500 dark:text-gray-400 italic">{r.notes}</span>}
                </div>
                <div className="pl-4 space-y-1">
                  {r.items.map(ri => (
                    <div key={ri.id} className="text-xs text-gray-600 dark:text-gray-400">
                      {ri.bookTitle}: {ri.quantityReceived} units
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(returns?.items ?? []).length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Returns to Supplier</h3>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {returns!.items.map(r => (
              <div key={r.id} className="p-4 flex items-center gap-4 text-sm">
                <button type="button" onClick={() => onOpenReturn(r.id)} className="font-mono text-xs text-blue-600 dark:text-blue-400 hover:underline">{r.returnNumber}</button>
                <span className="text-gray-600 dark:text-gray-300">{r.totalQuantity} copies · credit {po.currency} {amount(r.creditValue)}</span>
                <ReturnStatusBadge status={r.status} />
                <span className="text-gray-500 dark:text-gray-400 ml-auto">{new Date(r.createdAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <PaymentLists po={po} canPay={steps.pay} />

      {asking === 'cancel' && (
        <ActionDialog title={`Cancel ${po.poNumber}?`} message="The order is cancelled while nothing has arrived; it stays on record."
          confirmLabel="Cancel Order" tone="red" busy={step.isPending}
          onConfirm={() => run({ action: 'cancel' }, 'PO cancelled', onBack)} onCancel={() => setAsking(null)} />
      )}
      {asking === 'closeShort' && (
        <ActionDialog title={`Close ${po.poNumber} short?`} message="The rest of the order will not be delivered. The reason is kept with the order."
          confirmLabel="Close Short" reason={{ label: 'Why will the rest not be delivered?', max: 1000 }} busy={step.isPending}
          onConfirm={(reason) => run({ action: 'close', reason }, 'PO closed')} onCancel={() => setAsking(null)} />
      )}
    </div>
  );
}
