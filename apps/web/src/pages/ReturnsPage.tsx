import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId, getAccessToken } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

type Role = string;
interface ReturnsPageProps { userRole?: Role; }

interface TxLine { id: string; bookId: number; bookTitle: string; bookIsbn: string; quantity: number; unitPrice: number; discountPct: number; lineTotal: number; }
interface Transaction { id: string; transactionNumber: string; grandTotal: number; amountPaid: number; status: string; paymentStatus: string; createdAt: string; lineItems?: TxLine[]; }
interface ReturnLine { id: string; bookTitle: string; quantity: number; unitPrice: number; lineRefundAmount: number; }
interface ReturnRow { id: string; returnNumber: string; transactionId: string; totalRefundAmount: number; refundMethod: string; status: string; reason: string | null; createdAt: string; lineItems?: ReturnLine[]; }
interface ReturnListResponse { items: ReturnRow[]; total: number; page: number; totalPages: number; }

const canCreate = (r?: Role) => ['Sales', 'Manager', 'Admin'].includes(r ?? '');
const canApprove = (r?: Role) => ['Manager', 'Admin'].includes(r ?? '');
const canReject  = (r?: Role) => ['Manager', 'Admin'].includes(r ?? '');

type Tab = 'new' | 'list';

function getStaffIdFromToken(): number | null {
  const token = getAccessToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.staffId as number ?? null;
  } catch { return null; }
}

export default function ReturnsPage({ userRole }: ReturnsPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('new');
  const branchId = getCurrentBranchId() ?? 1;
  const currentStaffId = getStaffIdFromToken();

  // ── New Return state ──────────────────────────────────────────────────────────
  const [txSearch, setTxSearch]         = useState('');
  const [txSearchInput, setTxSearchInput] = useState('');
  const [selectedTx, setSelectedTx]     = useState<Transaction | null>(null);
  const [quantities, setQuantities]     = useState<Record<string, number>>({});
  const [refundMethod, setRefundMethod] = useState<'cash' | 'store_credit'>('cash');
  const [reason, setReason]             = useState('');
  const [useApproval, setUseApproval]   = useState(false);

  // ── List state ────────────────────────────────────────────────────────────────
  const [listPage, setListPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ── Queries ───────────────────────────────────────────────────────────────────
  // Search by exact transaction number via API filter
  const { data: txData, isLoading: txLoading, error: txError } = useQuery<Transaction | null>({
    queryKey: ['return-tx', txSearch],
    queryFn: async () => {
      if (!txSearch) return null;
      const res = await api.get<{ items: Transaction[] }>(
        `/pos/transactions?transactionNumber=${encodeURIComponent(txSearch)}&pageSize=1`,
      );
      if (!res.items || res.items.length === 0) throw new Error('Transaction not found');
      // Fetch full detail with line items
      return api.get<Transaction>(`/pos/transactions/${res.items[0].id}`);
    },
    enabled: txSearch.length > 5,
    retry: false,
  });

  const { data: listData, isLoading: listLoading } = useQuery<ReturnListResponse>({
    queryKey: ['returns-list', listPage, branchId],
    queryFn: () => api.get(`/returns?branchId=${branchId}&page=${listPage}&pageSize=20`),
    enabled: tab === 'list',
  });

  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<ReturnRow>('/returns', body),
    onSuccess: (ret) => {
      showToast(`Return ${ret.returnNumber} processed`, 'success');
      setSelectedTx(null); setTxSearch(''); setTxSearchInput('');
      setQuantities({}); setReason(''); setUseApproval(false);
      qc.invalidateQueries({ queryKey: ['returns-list'] });
    },
    onError: (e: Error) => {
      if (e.message.includes('APPROVAL_REQUIRED') || e.message.includes('Manager or Admin')) {
        showToast('This refund requires a Manager or Admin to process it directly.', 'error');
      } else {
        showToast(e.message, 'error');
      }
    },
  });

  const rejectMut = useMutation({
    mutationFn: (id: string) => api.post<ReturnRow>(`/returns/${id}/reject`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['returns-list'] }); showToast('Return rejected', 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // ── Derived ───────────────────────────────────────────────────────────────────
  const tx = selectedTx ?? txData ?? null;
  const lines = tx?.lineItems ?? [];

  const totalRefund = lines.reduce((s, li) => {
    const qty = quantities[li.id] ?? 0;
    return s + li.unitPrice * qty * (1 - (li.discountPct ?? 0) / 100);
  }, 0);

  function setQty(lineId: string, val: number, max: number) {
    setQuantities(q => ({ ...q, [lineId]: Math.max(0, Math.min(max, val)) }));
  }

  function handleSearch() {
    const val = txSearchInput.trim().toUpperCase();
    if (val.length < 6) { showToast('Enter a valid transaction number', 'error'); return; }
    setSelectedTx(null);
    setTxSearch(val);
  }

  function submitReturn() {
    if (!tx) return;
    const selectedLines = lines
      .filter(li => (quantities[li.id] ?? 0) > 0)
      .map(li => ({ transactionLineItemId: parseInt(li.id), quantity: quantities[li.id] }));
    if (selectedLines.length === 0) { showToast('Select at least one item to return', 'error'); return; }
    createMut.mutate({
      transactionId: parseInt(tx.id),
      refundMethod,
      reason: reason || undefined,
      lines: selectedLines,
      // Service auto-approves for Manager/Admin; Sales will get APPROVAL_REQUIRED if over limit
    });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex-shrink-0">
        {(['new', 'list'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-medium transition-colors ${tab === t ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {t === 'new' ? '↩ New Return' : '📋 Returns History'}
          </button>
        ))}
      </div>

      {/* ── New Return tab ── */}
      {tab === 'new' && (
        <div className="flex-1 overflow-auto p-4 pb-6 max-w-3xl mx-auto w-full space-y-4">

          {/* Step 1: Find transaction */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Step 1 — Find Transaction</h3>
            <div className="flex gap-2">
              <input
                value={txSearchInput}
                onChange={e => setTxSearchInput(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="Enter transaction number (e.g. POS-20250101-0001)"
                className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button onClick={handleSearch} disabled={txLoading}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
                {txLoading ? 'Searching...' : 'Search'}
              </button>
            </div>
            {txError && <p className="text-xs text-red-500">Transaction not found. Check the transaction number and try again.</p>}
            {txData && !selectedTx && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-sm space-y-1">
                <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Tx #</span><span className="font-mono text-gray-900 dark:text-white">{txData.transactionNumber}</span></div>
                <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Total</span><span className="text-gray-900 dark:text-white">ETB {Number(txData.grandTotal).toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Paid</span><span className="text-gray-900 dark:text-white">ETB {Number(txData.amountPaid ?? txData.grandTotal).toFixed(2)}</span></div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-500 dark:text-gray-400">Status</span>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${txData.status === 'voided' ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' : 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'}`}>{txData.status}</span>
                </div>
                <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Date</span><span className="text-gray-900 dark:text-white">{new Date(txData.createdAt).toLocaleString()}</span></div>
                {txData.status !== 'voided' && (
                  <button onClick={() => setSelectedTx(txData)} className="w-full mt-2 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors">
                    Use this transaction →
                  </button>
                )}
              </div>
            )}
            {selectedTx && (
              <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-950/30 rounded-lg px-3 py-2">
                <span className="text-sm font-medium text-blue-700 dark:text-blue-300">✓ {selectedTx.transactionNumber}</span>
                <button onClick={() => { setSelectedTx(null); setTxSearch(''); setTxSearchInput(''); setQuantities({}); }} className="text-xs text-gray-500 hover:text-red-500 transition-colors">Change</button>
              </div>
            )}
          </div>

          {/* Step 2: Select items */}
          {tx && tx.lineItems && (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Step 2 — Select Items to Return</h3>
              <div className="space-y-2">
                {tx.lineItems.map(li => (
                  <div key={li.id} className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{li.bookTitle}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">ETB {Number(li.unitPrice).toFixed(2)} × {li.quantity} sold</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 dark:text-gray-400">Return:</span>
                      <input type="number" min="0" max={li.quantity} value={quantities[li.id] ?? 0}
                        onChange={e => setQty(li.id, parseInt(e.target.value) || 0, li.quantity)}
                        className="w-16 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />
                      <span className="text-xs text-gray-400">/ {li.quantity}</span>
                    </div>
                    <div className="text-sm font-medium text-gray-900 dark:text-white w-24 text-right">
                      ETB {(li.unitPrice * (quantities[li.id] ?? 0) * (1 - (li.discountPct ?? 0) / 100)).toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Refund method + approval + submit */}
          {tx && (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Step 3 — Refund Details</h3>

              <div className="flex gap-2">
                {(['cash', 'store_credit'] as const).map(m => (
                  <button key={m} onClick={() => setRefundMethod(m)}
                    className={`flex-1 py-2 text-sm rounded-lg transition-colors ${refundMethod === m ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                    {m === 'cash' ? '💵 Cash' : '🏦 Store Credit'}
                  </button>
                ))}
              </div>

              <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for return (optional)"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />

              {/* Approval section */}
              {canApprove(userRole) ? (
                <div className="rounded-lg p-3 border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/30">
                  <p className="text-sm font-medium text-green-800 dark:text-green-300">✓ Manager/Admin Approval</p>
                  <p className="text-xs text-green-700 dark:text-green-400 mt-0.5">
                    As {userRole}, you can process returns of any amount. Your approval (Staff ID: {currentStaffId}) will be automatically recorded.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg p-3 border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-300">⚠ Approval Policy</p>
                  <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                    Refunds over ETB 500 must be processed by a Manager or Admin. Ask them to log in and process this return directly.
                  </p>
                </div>
              )}

              <div className="flex justify-between items-center pt-2 border-t border-gray-200 dark:border-gray-700">
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Total Refund</p>
                  <p className="text-lg font-bold text-gray-900 dark:text-white">ETB {totalRefund.toFixed(2)}</p>
                </div>
                {canCreate(userRole) && (
                  <button onClick={submitReturn}
                    disabled={createMut.isPending || totalRefund <= 0}
                    className="px-6 py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold rounded-lg transition-colors text-sm">
                    {createMut.isPending ? 'Processing...' : 'Process Return'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Returns History tab ── */}
      {tab === 'list' && (
        <div className="flex-1 overflow-auto p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
            {listLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : (
              <table className="w-full text-sm min-w-[700px]">
                <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <tr>{['Return #', 'Tx #', 'Refund', 'Method', 'Status', 'Date', 'Actions'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {(listData?.items ?? []).map(ret => (
                    <>
                      <tr key={ret.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer" onClick={() => setExpandedId(expandedId === ret.id ? null : ret.id)}>
                        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{ret.returnNumber}</td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">#{ret.transactionId}</td>
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">ETB {Number(ret.totalRefundAmount).toFixed(2)}</td>
                        <td className="px-4 py-3 text-xs capitalize text-gray-600 dark:text-gray-400">{ret.refundMethod.replace('_', ' ')}</td>
                        <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${ret.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>{ret.status}</span></td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(ret.createdAt).toLocaleString()}</td>
                        <td className="px-4 py-3">
                          {canReject(userRole) && ret.status === 'completed' && (
                            <button onClick={e => { e.stopPropagation(); if (confirm('Reject this return?')) rejectMut.mutate(ret.id); }}
                              className="text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950 px-2 py-1 rounded transition-colors">Reject</button>
                          )}
                        </td>
                      </tr>
                      {expandedId === ret.id && (
                        <tr key={`${ret.id}-detail`}>
                          <td colSpan={7} className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50">
                            {ret.reason && <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Reason: {ret.reason}</p>}
                            <ReturnDetailLoader returnId={ret.id} />
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            )}
            {(!listData?.items || listData.items.length === 0) && !listLoading && (
              <p className="text-center text-gray-400 text-sm py-8">No returns found</p>
            )}
          </div>
          {listData && listData.totalPages > 1 && (
            <div className="flex justify-between items-center mt-3 text-sm text-gray-500 dark:text-gray-400">
              <span>Page {listData.page} of {listData.totalPages}</span>
              <div className="flex gap-2">
                <button disabled={listPage <= 1} onClick={() => setListPage(p => p - 1)} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Prev</button>
                <button disabled={listPage >= listData.totalPages} onClick={() => setListPage(p => p + 1)} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Next</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReturnDetailLoader({ returnId }: { returnId: string }) {
  const { data } = useQuery<{ lineItems?: ReturnLine[] }>({
    queryKey: ['return-detail', returnId],
    queryFn: () => api.get(`/returns/${returnId}`),
  });
  if (!data?.lineItems) return <p className="text-xs text-gray-400">Loading...</p>;
  return (
    <table className="text-xs w-full max-w-lg">
      <thead><tr className="text-gray-500 dark:text-gray-400">{['Book', 'Qty', 'Refund'].map(h => <th key={h} className="text-left pr-4 pb-1">{h}</th>)}</tr></thead>
      <tbody>{data.lineItems.map((li, i) => <tr key={i}><td className="pr-4 text-gray-900 dark:text-white">{li.bookTitle}</td><td className="pr-4 text-gray-600 dark:text-gray-400">{li.quantity}</td><td className="text-gray-900 dark:text-white">ETB {Number(li.lineRefundAmount).toFixed(2)}</td></tr>)}</tbody>
    </table>
  );
}
