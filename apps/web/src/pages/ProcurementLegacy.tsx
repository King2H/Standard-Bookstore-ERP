import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, downloadFile, getCurrentBranchId } from '../lib/api.js';
import { paymentMethodPlainLabel } from '../lib/paymentMethods.js';
import { useToast } from '../components/Toast.js';
import BankAccountSelect from '../components/BankAccountSelect.js';
import { useBranchBankAccounts } from '../features/bankAccounts/queries.js';

// What is left of the old Procurement page until #23's PR 3 moves it to
// features/procurement: the supplier ledger, and an order's payments and
// credit notes. The page is features/procurement/pages.

// ── Types ─────────────────────────────────────────────────────────────────────

interface POLineItem {
  id: string; poId: string; bookId: number; bookTitle: string; bookIsbn: string;
  formatId: number | null; editionId: number | null; quantity: number; unitCost: number;
  receivedQuantity: number; remaining: number;
}
interface POReceiptItem { id: string; receiptId: string; poLineItemId: string; bookTitle: string; quantityReceived: number; }
interface POReceipt { id: string; poId: string; locationId: number; locationName: string; receivedBy: number; receivedAt: string; notes: string | null; items: POReceiptItem[]; }
interface SupplierPayment {
  id: string; paymentNumber?: string | null; poId: string; amount: number; paymentMethod: string; source: 'manual' | 'auto_on_receipt';
  notes: string | null; createdBy: number; createdAt: string;
  /** A reversed payment no longer counts as paid. */
  reversedAt?: string | null; reversalReason?: string | null;
}
interface CreditNote { id: string; creditNoteNumber?: string | null; poId: string; supplierId: number; amount: number; reason: string; createdBy: number; createdAt: string; }
interface PO {
  id: string; branchId: number; supplierId: number; supplierName: string;
  status: string; totalAmount: number; currency: string;
  expectedDeliveryDate: string | null; notes: string | null;
  receivingBranchId: number | null; receivingLocationId: number | null;
  receivingLocationName: string | null; financialStatus: 'unpaid' | 'partial' | 'paid';
  paymentTerms: 'cash' | 'credit';
  createdBy: number; approvedBy: number | null; createdAt: string; updatedAt: string;
  /** Why a part-received order was closed short. */
  closedReason?: string | null;
  lineItems?: POLineItem[]; receipts?: POReceipt[]; payments?: SupplierPayment[];
  creditNotes?: CreditNote[];
  // Prompt 2 — standardized procurement financial fields (computed on-read
  // by the backend; see procurement.service.ts's PO_FINANCIALS_SELECT).
  // receivedValue is the AP payable basis (value actually received), not
  // totalAmount (the full ordered value) — the two intentionally diverge
  // until a PO is fully received.
  receivedValue: number;
  amountPaid: number;
  creditNotesTotal: number;
  outstandingAmount: number;
  orderedQuantityTotal: number;
  receivedQuantityTotal: number;
}
interface SupplierLedgerEntry {
  date: string;
  type: 'PO' | 'GOODS_RECEIPT' | 'PAYMENT' | 'CREDIT_NOTE';
  reference: string;
  description: string;
  amount: number;
  balance: number;
}



// ── Legacy: supplier payments and credit notes (move to features/procurement in PR 3) ──

/** The payment and credit-note forms of an order's detail, as before #23's PR 1. */
export function LegacyPaymentForms({ po, canPay, onChanged }: { po: PO; canPay: boolean; onChanged: () => void }) {
  const { showToast } = useToast();
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentBankAccountId, setPaymentBankAccountId] = useState<number | null>(null);
  // The ordering branch pays; with Bank Accounts on, a bank payment names its account (#21).
  const { accounts: bankAccounts, required: bankAccountRequired } = useBranchBankAccounts(getCurrentBranchId(), paymentMethod === 'bank');
  const [creditAmount, setCreditAmount] = useState('');
  const [creditReason, setCreditReason] = useState('');
  const paymentMut = useMutation({
    mutationFn: () => api.post<PO>(`/purchase-orders/${po.id}/payments`, {
      amount: parseFloat(paymentAmount),
      paymentMethod,
      ...(paymentMethod === 'bank' && paymentBankAccountId ? { bankAccountId: paymentBankAccountId } : {}),
    }),
    onSuccess: () => { onChanged(); showToast('Payment recorded', 'success'); setPaymentAmount(''); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const creditNoteMut = useMutation({
    mutationFn: () => api.post<PO>(`/purchase-orders/${po.id}/credit-notes`, { amount: parseFloat(creditAmount), reason: creditReason }),
    onSuccess: () => { onChanged(); showToast('Credit note recorded', 'success'); setCreditAmount(''); setCreditReason(''); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const status = po.status;
  if (!(po.financialStatus !== 'paid' && !['draft', 'pending_approval', 'cancelled'].includes(status) && canPay)) return null;
  return (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Record Supplier Payment</h3>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Amount ({po.currency})</label>
                <input type="number" min={0.01} step="0.01" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-32 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Method</label>
                <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}
                  className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
                  <option value="cash">Cash</option>
                  <option value="bank">Bank Transfer</option>
                  <option value="mobile">Telebirr</option>
                  <option value="cheque">Cheque</option>
                </select>
              </div>
              {paymentMethod === 'bank' && bankAccountRequired && (
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Bank account</label>
                  <BankAccountSelect accounts={bankAccounts} value={paymentBankAccountId} onChange={setPaymentBankAccountId} />
                </div>
              )}
              <button
                onClick={() => {
                  const amt = parseFloat(paymentAmount);
                  if (!amt || amt <= 0) { showToast('Enter a positive amount', 'error'); return; }
                  if (paymentMethod === 'bank' && bankAccountRequired && !paymentBankAccountId) { showToast('Select the bank account the payment went out of', 'error'); return; }
                  paymentMut.mutate();
                }}
                disabled={paymentMut.isPending}
                className="px-4 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors">
                Record Payment
              </button>
            </div>
          </div>

          {/* Prompt 2 — the supported mechanism for correcting a PO's
              economics after receipt (damaged goods, overcharge, negotiated
              adjustment), since editing line items is only allowed while
              status === 'draft'. */}
          <div className="pt-4 border-t border-gray-100 dark:border-gray-800">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Issue Credit Note</h3>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Amount ({po.currency})</label>
                <input type="number" min={0.01} step="0.01" value={creditAmount} onChange={e => setCreditAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-32 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="flex-1 min-w-48">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Reason</label>
                <input type="text" value={creditReason} onChange={e => setCreditReason(e.target.value)}
                  placeholder="e.g. damaged goods, price adjustment"
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
              </div>
              <button
                onClick={() => {
                  const amt = parseFloat(creditAmount);
                  if (!amt || amt <= 0) { showToast('Enter a positive amount', 'error'); return; }
                  if (!creditReason.trim()) { showToast('A reason is required', 'error'); return; }
                  creditNoteMut.mutate();
                }}
                disabled={creditNoteMut.isPending}
                className="px-4 py-2 text-sm font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors">
                Issue Credit Note
              </button>
            </div>
          </div>
        </div>
  );
}

/** The payments and credit notes of an order's detail, as before #23's PR 1. */
export function LegacyPaymentLists({ po, canPay, onChanged }: { po: PO; canPay: boolean; onChanged: () => void }) {
  const { showToast } = useToast();
  const reverseMut = useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) =>
      api.post<PO>(`/purchase-orders/${po.id}/payments/${paymentId}/reverse`, { reason }),
    onSuccess: () => { onChanged(); showToast('Payment reversed', 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  // A payment recorded by mistake is reversed, with a reason; it stays on record.
  function reversePayment(paymentId: string) {
    const reason = prompt('Why is this payment being reversed?')?.trim();
    if (reason) reverseMut.mutate({ paymentId, reason });
  }
  return (
    <>
      {/* Supplier payments */}
      {(po.payments ?? []).length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Supplier Payments</h3>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {(po.payments ?? []).map(p => (
              <div key={p.id} className="p-4 flex items-center gap-4 text-sm">
                {p.paymentNumber && <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{p.paymentNumber}</span>}
                <span className={`font-medium text-gray-900 dark:text-white ${p.reversedAt ? 'line-through' : ''}`}>{po.currency} {Number(p.amount).toFixed(2)}</span>
                <span className="text-gray-500 dark:text-gray-400">{paymentMethodPlainLabel(p.paymentMethod === 'bank_transfer' ? 'bank' : p.paymentMethod)}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${p.source === 'auto_on_receipt' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>
                  {p.source === 'auto_on_receipt' ? 'auto (on receipt)' : 'manual'}
                </span>
                <span className="text-gray-500 dark:text-gray-400">{new Date(p.createdAt).toLocaleString()}</span>
                {p.notes && <span className="text-gray-500 dark:text-gray-400 italic">{p.notes}</span>}
                {p.reversedAt
                  ? <span className="text-xs text-red-600 dark:text-red-400">Reversed: {p.reversalReason}</span>
                  : canPay && (
                    <button onClick={() => reversePayment(p.id)} disabled={reverseMut.isPending}
                      className="ml-auto text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950 px-2 py-1 rounded-sm transition-colors">Reverse</button>
                  )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Credit notes (Prompt 2) */}
      {(po.creditNotes ?? []).length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Credit Notes</h3>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {(po.creditNotes ?? []).map(cn => (
              <div key={cn.id} className="p-4 flex items-center gap-4 text-sm">
                {cn.creditNoteNumber && <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{cn.creditNoteNumber}</span>}
                <span className="font-medium text-gray-900 dark:text-white">{po.currency} {Number(cn.amount).toFixed(2)}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">credit note</span>
                <span className="text-gray-500 dark:text-gray-400 italic">{cn.reason}</span>
                <span className="text-gray-500 dark:text-gray-400 ml-auto">{new Date(cn.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}


// ── View 5: Supplier Ledger ──────────────────────────────────────────────────

const LEDGER_TYPE_COLORS: Record<string, string> = {
  PO: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  GOODS_RECEIPT: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  PAYMENT: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  CREDIT_NOTE: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
};

export function SupplierLedgerView({ supplierId, supplierName, onBack }: { supplierId: number; supplierName: string; onBack: () => void }) {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const params = new URLSearchParams();
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  const qs = params.toString() ? `?${params}` : '';

  // Live-derived, not cached/materialized (see procurement.service.ts's
  // getSupplierLedger()) — but React Query still only refetches this on
  // mount/invalidation, not continuously. staleTime: 0 (the default) plus
  // a short poll gives it the same "Live" feel as the Dashboard's KPI
  // cards, so activity recorded elsewhere in the app (receiving, payments,
  // credit notes) while this view is open shows up without a manual reload.
  const { data, isLoading, dataUpdatedAt, refetch, isFetching } = useQuery<{ entries: SupplierLedgerEntry[]; currentBalance: number }>({
    queryKey: ['supplier-ledger', supplierId, dateFrom, dateTo],
    queryFn: () => api.get(`/suppliers/${supplierId}/ledger${qs}`),
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  // The API returns entries oldest→newest (required for the running-balance
  // math). Display newest-first instead — the standard convention for an
  // on-screen bank/AP statement — so today's activity is what you see first
  // without scrolling, instead of landing below however much older history
  // exists. (Root cause of "today's procurement not updated": the balance
  // total doesn't change when a PO is received AND fully paid in the same
  // day — receipt +value, payment −value nets to zero — so there was no
  // visible cue that rows existed further down an oldest-first list.)
  const entries = [...(data?.entries ?? [])].reverse();

  async function exportCsv() {
    await downloadFile(`/suppliers/${supplierId}/ledger/export${qs}`, `supplier-ledger-${supplierId}-${new Date().toISOString().slice(0, 10)}.csv`)
      .catch(() => {});
  }

  return (
    <div className="p-6 space-y-4 max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back</button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Supplier Ledger — {supplierName}</h2>
        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
          Live · 30s
        </span>
        {dataUpdatedAt > 0 && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            · Updated {new Date(dataUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          title="Refresh now"
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-40 transition-colors"
        >
          <svg className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {isFetching ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
        </div>
        <button onClick={exportCsv} className="px-3 py-2 text-xs font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
          Export CSV
        </button>
        <div className="ml-auto text-right">
          <div className="text-xs text-gray-500 dark:text-gray-400">Current Balance Owed</div>
          <div className="text-lg font-semibold text-gray-900 dark:text-white">{(data?.currentBalance ?? 0).toFixed(2)}</div>
        </div>
      </div>

      {entries.length > 0 && (
        <p className="text-xs text-gray-400 dark:text-gray-500">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'} · newest first
        </p>
      )}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No ledger activity for this supplier.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>{['Date', 'Type', 'Reference', 'Description', 'Amount', 'Balance'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {entries.map((e, i) => (
                <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{new Date(e.date).toLocaleDateString()}</td>
                  <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${LEDGER_TYPE_COLORS[e.type] ?? 'bg-gray-100 text-gray-700'}`}>{e.type.replace(/_/g, ' ')}</span></td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">{e.reference}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{e.description}</td>
                  <td className={`px-4 py-3 font-medium ${e.amount > 0 ? 'text-green-600 dark:text-green-400' : e.amount < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
                    {e.amount > 0 ? '+' : ''}{e.amount.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 font-semibold text-gray-900 dark:text-white">{e.balance.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
