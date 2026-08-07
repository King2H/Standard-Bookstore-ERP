import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { useCurrency } from '../lib/useCurrency.js';

type Role = string;
interface ReceivablesPageProps { userRole?: Role; userPermissions?: string[]; initialContext?: Record<string, string>; }

type ReceivableStatus = 'Pending' | 'PartiallyPaid' | 'Settled' | 'Overdue';
type ReceivableSourceType = 'pos_credit_sale' | 'exchange_difference' | 'order_credit_sale';
type PaymentMethod = 'cash' | 'bank' | 'store_credit';

interface ReceivableRow {
  id: string;
  sourceType: ReceivableSourceType;
  sourceRefId: string;
  customerId: number;
  customerName: string | null;
  customerCode: string | null;
  branchId: number;
  originalAmount: number;
  outstandingAmount: number;
  currency: string;
  dueDate: string | null;
  settlementDate: string | null;
  status: ReceivableStatus;
  notes: string | null;
  createdAt: string;
}

interface ReceivableList { items: ReceivableRow[]; total: number; page: number; totalPages: number; }

interface Summary {
  totalOutstanding: number;
  pendingCount: number;
  overdueCount: number;
  partiallyPaidCount: number;
  settledThisMonth: number;
}

const STATUS_COLORS: Record<ReceivableStatus, string> = {
  Pending:       'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  PartiallyPaid: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
  Settled:       'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  Overdue:       'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

const SOURCE_LABELS: Record<ReceivableSourceType, string> = {
  pos_credit_sale:     'POS Credit Sale',
  order_credit_sale:   'Order Credit Sale',
  exchange_difference: 'Exchange Diff.',
};

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function ReceivablesPage({ userRole, userPermissions, initialContext = {} }: ReceivablesPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const currency = useCurrency();
  const branchId = getCurrentBranchId() ?? 1;

  // ── Filters ──────────────────────────────────────────────────────────────────
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState(initialContext.status ?? '');
  const [sourceFilter, setSourceFilter] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);

  // ── Inline state ─────────────────────────────────────────────────────────────
  const [editingDueDateId, setEditingDueDateId] = useState<string | null>(null);
  const [dueDateDraft, setDueDateDraft] = useState('');
  const [writeOffId, setWriteOffId] = useState<string | null>(null);
  const [writeOffNotes, setWriteOffNotes] = useState('');
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [collectCustomerId, setCollectCustomerId] = useState<number | null>(null);
  const [collectAmount, setCollectAmount] = useState('');
  const [collectMethod, setCollectMethod] = useState<PaymentMethod>('cash');
  const [collectBankAccountId, setCollectBankAccountId] = useState<number | ''>('');
  const [collectNotes, setCollectNotes] = useState('');

  const { data: bankAccountsData } = useQuery<{ items: Array<{ id: number; accountName: string; bankName: string }> }>({
    queryKey: ['bank-accounts-for-receivables', branchId],
    queryFn: () => api.get(`/branches/${branchId}/bank-accounts`),
    enabled: collectMethod === 'bank',
  });

  // Store credit was already accepted as a collect method server-side, but
  // the modal never showed the customer's available balance — staff only
  // found out it was insufficient after submitting and getting a 422. Fetch
  // it whenever the modal is open so it's visible before that happens.
  const { data: collectingCustomer } = useQuery<{ storeCreditBalance: number }>({
    queryKey: ['customer-for-collect', collectCustomerId],
    queryFn: () => api.get(`/customers/${collectCustomerId}`),
    enabled: !!collectCustomerId,
  });

  // ── Queries ───────────────────────────────────────────────────────────────────
  const params = new URLSearchParams({ branchId: String(branchId), page: String(page), pageSize: '25' });
  if (statusFilter) params.set('status', statusFilter);
  if (sourceFilter) params.set('sourceType', sourceFilter);
  if (overdueOnly) params.set('overdueOnly', 'true');

  const { data, isLoading } = useQuery<ReceivableList>({
    queryKey: ['receivables', branchId, page, statusFilter, sourceFilter, overdueOnly],
    queryFn: () => api.get(`/receivables?${params}`),
  });

  const { data: summary } = useQuery<Summary>({
    queryKey: ['receivables-summary', branchId],
    queryFn: () => api.get(`/receivables/summary?branchId=${branchId}`),
    staleTime: 30_000,
  });

  const inv = () => {
    qc.invalidateQueries({ queryKey: ['receivables'] });
    qc.invalidateQueries({ queryKey: ['receivables-summary'] });
  };

  // ── Mutations ─────────────────────────────────────────────────────────────────
  // Collect: the normal "customer paid" action — routes server-side to the
  // receivable's own source-type payment pipeline (order/POS/exchange), so
  // the amount and method are always recorded, store credit is deducted when
  // used, and the collection shows up in Payments/Dashboard reporting.
  const collectMut = useMutation({
    mutationFn: ({ id, amount, paymentMethod, bankAccountId, notes }: { id: string; amount: number; paymentMethod: PaymentMethod; bankAccountId?: number; notes?: string }) =>
      api.post(`/receivables/${id}/collect`, { amount, paymentMethod, bankAccountId, notes: notes || undefined }),
    onSuccess: () => {
      inv();
      setCollectingId(null); setCollectCustomerId(null); setCollectAmount(''); setCollectMethod('cash'); setCollectBankAccountId(''); setCollectNotes('');
      showToast('Payment collected', 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // Write off: bad-debt only — records no payment. Restricted server-side to
  // Admin/Manager/Finance_Officer.
  const writeOffMut = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes: string }) =>
      api.post(`/receivables/${id}/settle`, { notes: notes || undefined }),
    onSuccess: () => { inv(); setWriteOffId(null); setWriteOffNotes(''); showToast('Receivable written off', 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const dueDateMut = useMutation({
    mutationFn: ({ id, dueDate }: { id: string; dueDate: string | null }) =>
      api.patch(`/receivables/${id}/due-date`, { dueDate }),
    onSuccess: () => { inv(); setEditingDueDateId(null); showToast('Due date updated', 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const canWrite = (perms?: string[]) =>
    perms?.includes('PROCESS_PAYMENT') ||
    ['Admin', 'Manager', 'Finance_Officer'].includes(userRole ?? '');
  // Write-off is stricter than routine collection — matches the backend's
  // requireRole('Admin', 'Manager', 'Finance_Officer') on POST /:id/settle.
  const canWriteOff = () => ['Admin', 'Manager', 'Finance_Officer'].includes(userRole ?? '');

  const receivables = data?.items ?? [];
  const fmt = (n: number) => `${currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

  return (
    <div className="p-6 space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Total Outstanding', value: summary ? fmt(summary.totalOutstanding) : '—', color: 'text-red-600 dark:text-red-400' },
          { label: 'Overdue',           value: summary?.overdueCount ?? '—',       color: 'text-red-500 dark:text-red-400' },
          { label: 'Pending',           value: summary?.pendingCount ?? '—',       color: 'text-blue-600 dark:text-blue-400' },
          { label: 'Partially Paid',    value: summary?.partiallyPaidCount ?? '—', color: 'text-yellow-600 dark:text-yellow-400' },
          { label: 'Settled This Month',value: summary?.settledThisMonth ?? '—',   color: 'text-green-600 dark:text-green-400' },
        ].map(c => (
          <div key={c.label} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 text-center">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{c.label}</p>
            <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 flex flex-wrap gap-3 items-center">
        <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Statuses</option>
          {['Pending', 'PartiallyPaid', 'Settled', 'Overdue'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={sourceFilter} onChange={e => { setSourceFilter(e.target.value); setPage(1); }}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Types</option>
          <option value="pos_credit_sale">POS Credit Sale</option>
          <option value="order_credit_sale">Order Credit Sale</option>
          <option value="exchange_difference">Exchange Diff.</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
          <input type="checkbox" checked={overdueOnly} onChange={e => { setOverdueOnly(e.target.checked); setPage(1); }}
            className="rounded border-gray-300 dark:border-gray-600 text-red-500" />
          Overdue only
        </label>
        <div className="ml-auto text-sm text-gray-500 dark:text-gray-400">{data?.total ?? 0} records</div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : receivables.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No receivables found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[800px]">
              <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <tr>
                  {['Customer', 'Type', 'Reference', 'Original', 'Outstanding', 'Due Date', 'Status', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {receivables.map(rec => (
                  <tr key={rec.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    {/* Customer */}
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900 dark:text-white">{rec.customerName ?? '—'}</p>
                      <p className="text-xs text-gray-400">{rec.customerCode ?? ''}</p>
                    </td>
                    {/* Type */}
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                        {SOURCE_LABELS[rec.sourceType]}
                      </span>
                    </td>
                    {/* Reference */}
                    <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{rec.sourceRefId}</td>
                    {/* Original */}
                    <td className="px-4 py-3 text-right text-gray-900 dark:text-white whitespace-nowrap">{fmt(rec.originalAmount)}</td>
                    {/* Outstanding */}
                    <td className="px-4 py-3 text-right font-semibold whitespace-nowrap">
                      <span className={rec.outstandingAmount > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}>
                        {fmt(rec.outstandingAmount)}
                      </span>
                    </td>
                    {/* Due Date */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      {editingDueDateId === rec.id ? (
                        <div className="flex gap-1 items-center">
                          <input type="date" value={dueDateDraft} onChange={e => setDueDateDraft(e.target.value)}
                            className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
                          <button onClick={() => dueDateMut.mutate({ id: rec.id, dueDate: dueDateDraft || null })}
                            disabled={dueDateMut.isPending}
                            className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors disabled:opacity-50">✓</button>
                          <button onClick={() => setEditingDueDateId(null)}
                            className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">✕</button>
                        </div>
                      ) : (
                        <span className={rec.status === 'Overdue' ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-600 dark:text-gray-400'}>
                          {fmtDate(rec.dueDate)}
                        </span>
                      )}
                    </td>
                    {/* Status */}
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[rec.status]}`}>
                        {rec.status === 'PartiallyPaid' ? 'Partial' : rec.status}
                      </span>
                    </td>
                    {/* Actions */}
                    <td className="px-4 py-3">
                      {rec.status !== 'Settled' && canWrite(userPermissions) && (
                        <div className="flex gap-1 text-xs">
                          {/* Edit due date */}
                          <button
                            onClick={() => { setEditingDueDateId(rec.id); setDueDateDraft(rec.dueDate ?? ''); }}
                            title="Set due date"
                            className="px-2 py-1 rounded text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors">
                            📅
                          </button>
                          {/* Collect payment — the normal "customer paid" action */}
                          <button
                            onClick={() => { setCollectingId(rec.id); setCollectCustomerId(rec.customerId); setCollectAmount(rec.outstandingAmount.toFixed(2)); setCollectMethod('cash'); setCollectBankAccountId(''); setCollectNotes(''); }}
                            title="Collect payment"
                            className="px-2 py-1 rounded text-green-600 hover:bg-green-50 dark:hover:bg-green-950 transition-colors">
                            💰 Collect
                          </button>
                          {/* Write off — bad debt only, restricted */}
                          {canWriteOff() && (
                            <button
                              onClick={() => { setWriteOffId(rec.id); setWriteOffNotes(''); }}
                              title="Write off (no payment collected)"
                              className="px-2 py-1 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                              ✕ Write Off
                            </button>
                          )}
                        </div>
                      )}
                      {rec.status === 'Settled' && (
                        <span className="text-xs text-gray-400">{fmtDate(rec.settlementDate)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
          <span>Page {data.page} of {data.totalPages}</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
              className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Prev</button>
            <button disabled={page >= data.totalPages} onClick={() => setPage(p => p + 1)}
              className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Next</button>
          </div>
        </div>
      )}

      {/* ── Collect Payment modal ────────────────────────────────────────────── */}
      {collectingId && (() => {
        const rec = receivables.find(r => r.id === collectingId);
        if (!rec) return null;
        const amt = parseFloat(collectAmount) || 0;
        const storeCreditBalance = collectingCustomer?.storeCreditBalance ?? null;
        const storeCreditInsufficient = collectMethod === 'store_credit' && storeCreditBalance != null && amt > storeCreditBalance + 0.01;
        const invalid = amt <= 0 || amt > rec.outstandingAmount + 0.01 || (collectMethod === 'bank' && !collectBankAccountId) || storeCreditInsufficient;
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => { setCollectingId(null); setCollectCustomerId(null); }}>
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 w-full max-w-sm space-y-4" onClick={e => e.stopPropagation()}>
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Collect Payment</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {rec.customerName ?? 'Customer'} · Outstanding: <strong>{fmt(rec.outstandingAmount)}</strong> ({SOURCE_LABELS[rec.sourceType]})
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Amount ({currency})</label>
                <input type="number" min={0.01} max={rec.outstandingAmount} step="0.01" value={collectAmount} onChange={e => setCollectAmount(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Method</label>
                <select value={collectMethod} onChange={e => setCollectMethod(e.target.value as PaymentMethod)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500">
                  <option value="cash">Cash</option>
                  <option value="bank">Bank Transfer</option>
                  <option value="store_credit">Store Credit{storeCreditBalance != null ? ` (${fmt(storeCreditBalance)} available)` : ''}</option>
                </select>
              </div>
              {collectMethod === 'bank' && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Bank Account</label>
                  <select value={collectBankAccountId} onChange={e => setCollectBankAccountId(Number(e.target.value) || '')}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500">
                    <option value="">Select bank account…</option>
                    {(bankAccountsData?.items ?? []).map(ba => <option key={ba.id} value={ba.id}>{ba.accountName} — {ba.bankName}</option>)}
                  </select>
                </div>
              )}
              {collectMethod === 'store_credit' && (
                <p className={`text-xs rounded-lg px-3 py-2 ${storeCreditInsufficient ? 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400' : 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400'}`}>
                  {storeCreditBalance == null
                    ? 'Loading available store credit…'
                    : storeCreditInsufficient
                      ? `⚠️ Only ${fmt(storeCreditBalance)} available — reduce the amount or choose another method.`
                      : `✓ ${fmt(storeCreditBalance)} available on this customer's account.`}
                </p>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
                <input value={collectNotes} onChange={e => setCollectNotes(e.target.value)} placeholder="Reference, description…"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500" />
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => { setCollectingId(null); setCollectCustomerId(null); }}
                  className="flex-1 px-4 py-2 text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Cancel</button>
                <button
                  onClick={() => collectMut.mutate({ id: rec.id, amount: amt, paymentMethod: collectMethod, bankAccountId: collectBankAccountId || undefined, notes: collectNotes })}
                  disabled={invalid || collectMut.isPending}
                  className="flex-1 px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg transition-colors">
                  {collectMut.isPending ? 'Collecting…' : 'Collect'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Write Off modal ──────────────────────────────────────────────────── */}
      {writeOffId && (() => {
        const rec = receivables.find(r => r.id === writeOffId);
        if (!rec) return null;
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setWriteOffId(null)}>
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 w-full max-w-sm space-y-4" onClick={e => e.stopPropagation()}>
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Write Off Receivable</h3>
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 bg-amber-50 dark:bg-amber-950/30 rounded-lg px-3 py-2">
                  ⚠️ This marks {fmt(rec.outstandingAmount)} as uncollectible — no payment is recorded, and it will not appear in Payments reporting. Use Collect instead if the customer actually paid.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Reason</label>
                <input value={writeOffNotes} onChange={e => setWriteOffNotes(e.target.value)} placeholder="Why is this being written off?"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500" />
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => setWriteOffId(null)}
                  className="flex-1 px-4 py-2 text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Cancel</button>
                <button
                  onClick={() => writeOffMut.mutate({ id: rec.id, notes: writeOffNotes })}
                  disabled={writeOffMut.isPending}
                  className="flex-1 px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg transition-colors">
                  {writeOffMut.isPending ? 'Writing off…' : 'Write Off'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
