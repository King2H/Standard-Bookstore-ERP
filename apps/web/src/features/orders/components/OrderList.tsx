import { Fragment, useState, type MouseEvent } from 'react';
import { Money, type CancelOrderRequest, type Order } from '@bms/shared';
import { ActionDialog } from '../../../components/ActionDialog.js';
import BankAccountSelect from '../../../components/BankAccountSelect.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import PaymentProofFields from '../../../components/PaymentProofFields.js';
import { useToast } from '../../../components/Toast.js';
import { getCurrentBranchId } from '../../../lib/api.js';
import { paymentMethodLabel, type PaymentMethodCode } from '../../../lib/paymentMethods.js';
import { EMPTY_PROOF, type PaymentProof } from '../../../lib/paymentProof.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { useBranchBankAccounts } from '../../bankAccounts/queries.js';
import {
  useCancelOrder, useCancelOrderRest, useConfirmOrder, useDeleteOrder, useDeliverOrder, useFulfillOrder, useOrders,
} from '../queries.js';
import {
  canDeleteOrder, cashConfirmBody, cashPaymentProblem, isDeletable, PENDING_FULFILLMENT, STATUS_FILTERS, statusLabel,
} from '../rules.js';
import { CancelOrderDialog } from './CancelOrderDialog.js';
import { CancelRestDialog } from './CancelRestDialog.js';
import { DeliverDialog } from './DeliverDialog.js';
import { DeliveryNote } from './DeliveryNote.js';
import { OrderDetail } from './OrderDetail.js';
import { OrderSlip } from './OrderSlip.js';

// Lifecycle status colours — covers both legacy and new values
const STATUS_COLORS: Record<string, string> = {
  Pending:     'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  Confirmed:   'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  In_Progress: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  Fulfilled:   'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  Cancelled:   'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  DRAFT:       'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  CONFIRMED:   'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  PAID:        'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
  PART_DELIVERED: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  FULFILLED:   'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  COMPLETED:   'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  CANCELLED:   'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
};

const PAY_COLORS: Record<string, string> = {
  unpaid:   'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  partial:  'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  paid:     'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  refunded: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

const ACTION = {
  confirm: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 hover:bg-blue-200',
  fulfill: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 hover:bg-purple-200',
  cancel:  'text-red-600 hover:bg-red-50 dark:hover:bg-red-950',
  print:   'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
  return:  'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 hover:bg-amber-200',
};

// Methods a cash order can be paid with at confirmation (orders.policy confirmPaymentMethod).
const CASH_PAYMENT_METHODS: PaymentMethodCode[] = ['cash', 'bank', 'mobile', 'store_credit'];

const SELECT = 'px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const FILTER = 'px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const INLINE = 'text-xs px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white';

type Asking = { kind: 'cancel' | 'delete' | 'deliver' | 'cancel_rest'; order: Order } | null;

/**
 * The branch's orders, newest first, with the steps each is open to (as the
 * API reports them): confirm a draft, fulfil, cancel with a reason, print,
 * delete a draft or cancelled one (Admin), or collect what is owed in Payments.
 */
export function OrderList({ initialContext = {}, onNavigate, onEdit }: {
  initialContext?: Record<string, string>;
  onNavigate?: (page: string, context?: Record<string, string>) => void;
  /** Opens a draft in the order form (#174). */
  onEdit?: (order: Order) => void;
}) {
  const { showToast } = useToast();
  const currency = useCurrency();
  const { data: me } = useMyProfile();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  // The Dashboard opens the list for a status or a date range.
  const [status, setStatus] = useState(initialContext.status ?? '');
  const [dateFrom, setDateFrom] = useState(initialContext.dateFrom ?? '');
  const [dateTo, setDateTo] = useState(initialContext.dateTo ?? '');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [printing, setPrinting] = useState<string | null>(null);
  const [note, setNote] = useState<{ orderId: string; deliveryId: number } | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmDueDate, setConfirmDueDate] = useState('');
  const [confirmMethod, setConfirmMethod] = useState('');
  const [confirmProof, setConfirmProof] = useState<PaymentProof>(EMPTY_PROOF);
  const [confirmBankAccountId, setConfirmBankAccountId] = useState<number | null>(null);

  const { data: listData, isLoading } = useOrders({ page, pageSize, status, dateFrom, dateTo });
  // With Bank Accounts on, a bank payment names the account it went to (#21).
  const { accounts: bankAccounts, required: bankAccountRequired } = useBranchBankAccounts(getCurrentBranchId(), confirmMethod === 'bank');
  const confirm = useConfirmOrder();
  const fulfill = useFulfillOrder();
  const cancel = useCancelOrder();
  const remove = useDeleteOrder();
  const deliver = useDeliverOrder();
  const cancelRest = useCancelOrderRest();
  const busy = confirm.isPending || fulfill.isPending || cancel.isPending || deliver.isPending || cancelRest.isPending;

  const filtered = (set: (v: string) => void) => (v: string) => { set(v); setPage(1); };
  const onError = (e: Error) => showToast(e.message, 'error');

  function openConfirm(order: Order) {
    setConfirmingId(order.id); setConfirmDueDate(''); setConfirmMethod(''); setConfirmProof(EMPTY_PROOF); setConfirmBankAccountId(null);
  }
  const closeConfirm = () => setConfirmingId(null);
  const updated = () => { showToast('Order updated', 'success'); setConfirmingId(null); };

  function confirmCash(order: Order) {
    const problem = cashPaymentProblem(confirmMethod, confirmProof, confirmBankAccountId, bankAccountRequired);
    if (problem) { showToast(problem, 'error'); return; }
    confirm.mutate({ id: order.id, body: cashConfirmBody(confirmMethod, confirmProof, confirmBankAccountId) }, { onSuccess: updated, onError });
  }

  function answer() {
    if (!asking) return;
    const done = () => setAsking(null);
    if (asking.kind === 'delete') {
      remove.mutate(asking.order.id, { onSuccess: () => { done(); showToast('Order deleted', 'success'); }, onError });
    }
  }

  function cancelAsked(body: CancelOrderRequest) {
    if (asking?.kind !== 'cancel') return;
    cancel.mutate({ id: asking.order.id, body }, {
      onSuccess: () => { setAsking(null); updated(); if (body.refundTo) showToast('The money the order took went back', 'success'); },
      onError,
    });
  }

  // Each delivery opens its note, to print for the customer (#174, decision 2a).
  function deliverAsked(body: { lines: Array<{ lineId: number; quantity: number }>; notes?: string }) {
    if (asking?.kind !== 'deliver') return;
    deliver.mutate({ id: asking.order.id, body }, {
      onSuccess: (o) => {
        setAsking(null);
        showToast(o.status === 'PART_DELIVERED' ? 'Delivered; the rest waits' : 'Delivered; the order is complete', 'success');
        const last = o.deliveries?.[o.deliveries.length - 1];
        if (last) setNote({ orderId: o.id, deliveryId: last.id });
      },
      onError,
    });
  }

  function cancelRestAsked(body: CancelOrderRequest) {
    if (asking?.kind !== 'cancel_rest') return;
    cancelRest.mutate({ id: asking.order.id, body }, {
      onSuccess: () => { setAsking(null); showToast('The rest was cancelled; the order is complete', 'success'); },
      onError,
    });
  }

  function actionsOf(order: Order) {
    const stop = (e: MouseEvent) => e.stopPropagation();
    return order.allowedActions.map((action) => {
      // A draft is edited until it is confirmed (#174, decision 1a).
      if (action === 'edit') {
        return onEdit && (
          <button key="edit" onClick={(e) => { stop(e); onEdit(order); }}
            className={`text-xs px-2 py-0.5 rounded-sm transition-colors ${ACTION.print}`}>
            Edit
          </button>
        );
      }
      if (action === 'cancel') {
        return (
          <button key="cancel" onClick={(e) => { stop(e); setAsking({ kind: 'cancel', order }); }}
            className={`text-xs px-2 py-0.5 rounded-sm transition-colors ${ACTION.cancel}`}>
            Cancel
          </button>
        );
      }
      // A credit order owes by its due date; the API takes today or later.
      if (action === 'confirm' && order.saleType === 'credit_sale') {
        return confirmingId === order.id ? (
          <div key="confirm-credit" className="flex gap-1" onClick={stop}>
            <input type="date" aria-label="Due date" value={confirmDueDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setConfirmDueDate(e.target.value)} className={INLINE} />
            <button disabled={!confirmDueDate || busy}
              onClick={() => confirm.mutate({ id: order.id, body: { dueDate: confirmDueDate } }, { onSuccess: updated, onError })}
              className="text-xs bg-blue-600 disabled:opacity-40 text-white px-2 py-0.5 rounded-sm">OK</button>
            <button onClick={closeConfirm} className="text-xs text-gray-500 px-1">✕</button>
          </div>
        ) : (
          <button key="confirm-credit-open" onClick={(e) => { stop(e); openConfirm(order); }}
            className={`text-xs px-2 py-0.5 rounded-sm transition-colors ${ACTION.confirm}`}>
            Confirm (set due date)
          </button>
        );
      }
      // A cash order is paid at confirmation: its method, and for bank and Telebirr the proof.
      if (action === 'confirm') {
        return confirmingId === order.id ? (
          <div key="confirm-cash" className="flex flex-wrap items-start gap-1" onClick={stop}>
            <select aria-label="Payment method" value={confirmMethod} onChange={(e) => setConfirmMethod(e.target.value)} className={INLINE}>
              <option value="">Payment method…</option>
              {CASH_PAYMENT_METHODS.map((code) => <option key={code} value={code}>{paymentMethodLabel(code)}</option>)}
            </select>
            {confirmMethod === 'bank' && bankAccountRequired && (
              <BankAccountSelect accounts={bankAccounts} value={confirmBankAccountId} onChange={setConfirmBankAccountId} className={`w-40 ${INLINE}`} />
            )}
            <PaymentProofFields method={confirmMethod} value={confirmProof} onChange={setConfirmProof} inputClassName={`w-40 ${INLINE}`} />
            <button disabled={!confirmMethod || busy} onClick={() => confirmCash(order)}
              className="text-xs bg-blue-600 disabled:opacity-40 text-white px-2 py-0.5 rounded-sm">OK</button>
            <button onClick={closeConfirm} className="text-xs text-gray-500 px-1">✕</button>
          </div>
        ) : (
          <button key="confirm-cash-open" onClick={(e) => { stop(e); openConfirm(order); }}
            className={`text-xs px-2 py-0.5 rounded-sm transition-colors ${ACTION.confirm}`}>
            Confirm (set payment method)
          </button>
        );
      }
      if (action === 'fulfill') {
        return (
          <button key="fulfill" disabled={busy} onClick={(e) => { stop(e); fulfill.mutate(order.id, { onSuccess: updated, onError }); }}
            className={`text-xs px-2 py-0.5 rounded-sm transition-colors ${ACTION.fulfill}`}>
            Fulfill
          </button>
        );
      }
      // Some of the copies (#174); Fulfill above still hands over everything.
      if (action === 'deliver') {
        return (
          <button key="deliver" disabled={busy} onClick={(e) => { stop(e); setAsking({ kind: 'deliver', order }); }}
            className={`text-xs px-2 py-0.5 rounded-sm transition-colors ${ACTION.fulfill}`}>
            Deliver…
          </button>
        );
      }
      if (action === 'cancel_rest') {
        return (
          <button key="cancel_rest" disabled={busy} onClick={(e) => { stop(e); setAsking({ kind: 'cancel_rest', order }); }}
            className={`text-xs px-2 py-0.5 rounded-sm transition-colors ${ACTION.cancel}`}>
            Cancel the rest…
          </button>
        );
      }
      if (action === 'print') {
        return (
          <button key="print" onClick={(e) => { stop(e); setPrinting(order.id); }}
            className={`text-xs px-2 py-0.5 rounded-sm transition-colors ${ACTION.print}`}>
            🖨 Print
          </button>
        );
      }
      // A delivered order is returned in Returns, opened on this order (#166).
      if (action === 'return') {
        return (
          <button key="return" onClick={(e) => { stop(e); onNavigate?.('returns', { sale: order.orderNumber }); }}
            className={`text-xs px-2 py-0.5 rounded-sm transition-colors ${ACTION.return}`}>
            ↩ Return
          </button>
        );
      }
      // A step this page does not know has no button (was: a button posting to an endpoint that does not exist).
      return null;
    });
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-3">
      <div className="flex gap-2 items-center flex-wrap">
        <select aria-label="Status" value={status} onChange={(e) => filtered(setStatus)(e.target.value)} className={SELECT}>
          <option value="">All statuses</option>
          <option value={PENDING_FULFILLMENT}>Pending Fulfillment (Confirmed/Paid/Part delivered)</option>
          {STATUS_FILTERS.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>
        <input type="date" aria-label="From date" value={dateFrom} onChange={(e) => filtered(setDateFrom)(e.target.value)} className={FILTER} />
        <span className="text-xs text-gray-400">to</span>
        <input type="date" aria-label="To date" value={dateTo} onChange={(e) => filtered(setDateTo)(e.target.value)} className={FILTER} />
        {(status || dateFrom || dateTo) && (
          <button onClick={() => { setStatus(''); setDateFrom(''); setDateTo(''); setPage(1); }}
            className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            Clear
          </button>
        )}
      </div>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        {isLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : (
          <table className="w-full text-sm min-w-[800px]">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>{['Order #', 'Channel', 'Status', 'Payment', 'Total', 'Date', 'Actions'].map((h) => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {(listData?.items ?? []).map((order) => (
                <Fragment key={order.id}>
                  <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer" onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{order.orderNumber}</td>
                    <td className="px-4 py-3 text-xs capitalize text-gray-600 dark:text-gray-400">{order.channel.replace('_', ' ')}</td>
                    <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[order.status] ?? ''}`}>{statusLabel(order.status)}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 flex-wrap">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PAY_COLORS[order.paymentStatus] ?? ''}`}>{order.paymentStatus}</span>
                        {order.saleType === 'credit_sale' && <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">Credit</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">{currency} {Money.of(order.total).toFixed()}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(order.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 flex-wrap">
                        {actionsOf(order)}
                        {/* Payments is the only place that collects: this opens its Collect tab for the order. */}
                        {(order.paymentStatus === 'unpaid' || order.paymentStatus === 'partial') && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onNavigate?.('payments', { orderId: order.id, sourceType: 'order' }); }}
                            className="text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 px-2 py-0.5 rounded-lg font-semibold transition-colors whitespace-nowrap"
                          >View Payments</button>
                        )}
                        {canDeleteOrder(me) && isDeletable(order.status) && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setAsking({ kind: 'delete', order }); }}
                            disabled={remove.isPending}
                            className="text-xs px-2 py-0.5 rounded-sm transition-colors text-red-600 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
                          >
                            🗑 Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedId === order.id && (
                    <tr>
                      <td colSpan={7} className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50">
                        <OrderDetail orderId={order.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {(!listData?.items || listData.items.length === 0) && !isLoading && <p className="text-center text-gray-400 text-sm py-8">No orders found</p>}
        {listData && (
          <Pagination
            page={page} pageSize={pageSize} total={listData.total} totalPages={listData.totalPages}
            onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
            itemLabel="order"
          />
        )}
      </div>

      {printing && <OrderSlip orderId={printing} onClose={() => setPrinting(null)} />}
      {note && <DeliveryNote orderId={note.orderId} deliveryId={note.deliveryId} onClose={() => setNote(null)} />}
      {asking?.kind === 'deliver' && (
        <DeliverDialog order={asking.order} busy={deliver.isPending} onConfirm={deliverAsked} onCancel={() => setAsking(null)} />
      )}
      {asking?.kind === 'cancel_rest' && (
        <CancelRestDialog order={asking.order} currency={currency} busy={cancelRest.isPending} onConfirm={cancelRestAsked} onCancel={() => setAsking(null)} />
      )}

      {asking?.kind === 'cancel' && (
        <CancelOrderDialog order={asking.order} currency={currency} busy={cancel.isPending} onConfirm={cancelAsked} onCancel={() => setAsking(null)} />
      )}
      {asking?.kind === 'delete' && (
        <ActionDialog
          title="Delete Order"
          message={`Permanently delete order ${asking.order.orderNumber}? This cannot be undone.`}
          confirmLabel="Delete Order"
          tone="red"
          busy={remove.isPending}
          onConfirm={() => answer()}
          onCancel={() => setAsking(null)}
        />
      )}
    </div>
  );
}
