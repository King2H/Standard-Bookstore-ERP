import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

type Role = string;
interface PaymentsPageProps { userRole?: Role; }

interface Payment { id: string; paymentReference: string; orderId: string; amount: number; currency: string; paymentMethod: string; status: string; transactionReference: string | null; processedAt: string; createdAt: string; }
interface Refund { id: string; paymentId: string; orderId: string; refundAmount: number; reason: string; createdAt: string; }
interface PaymentListResponse { items: Payment[]; total: number; page: number; totalPages: number; }
interface OrderBalance { orderTotal: number; totalPaid: number; totalRefunded: number; outstanding: number; paymentStatus: string; }

const STATUS_COLORS: Record<string, string> = {
  success: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  refunded: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  partially_refunded: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
};

const METHOD_LABELS: Record<string, string> = {
  cash: '💵 Cash', bank: '🏦 Bank', mobile: '📱 Mobile', card: '💳 Card',
  store_credit: '🏦 Store Credit', loyalty_points: '⭐ Loyalty', other: 'Other',
};

const canRefund = (r?: Role) => ['Manager', 'Admin'].includes(r ?? '');

type Tab = 'list' | 'new';

export default function PaymentsPage({ userRole }: PaymentsPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('list');

  // List state
  const [listPage, setListPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // New payment state
  const [orderIdInput, setOrderIdInput] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<string>('cash');
  const [txRef, setTxRef] = useState('');
  const [orderBalance, setOrderBalance] = useState<OrderBalance | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  // Refund state
  const [refundingId, setRefundingId] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');

  // Queries
  const { data: listData, isLoading } = useQuery<PaymentListResponse>({
    queryKey: ['payments-list', listPage, statusFilter],
    queryFn: () => api.get(`/payments?page=${listPage}&pageSize=20${statusFilter ? `&status=${statusFilter}` : ''}`),
    enabled: tab === 'list',
  });

  // Mutations
  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<Payment>('/payments', body),
    onSuccess: (p) => {
      showToast(`Payment ${p.paymentReference} recorded`, 'success');
      setOrderIdInput(''); setAmount(''); setTxRef(''); setOrderBalance(null);
      qc.invalidateQueries({ queryKey: ['payments-list'] });
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const refundMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.post<Refund>(`/payments/${id}/refund`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments-list'] });
      showToast('Refund processed', 'success');
      setRefundingId(null); setRefundAmount(''); setRefundReason('');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  async function loadOrderBalance() {
    if (!orderIdInput.trim()) return;
    setLoadingBalance(true);
    try {
      const bal = await api.get<OrderBalance>(`/orders/${orderIdInput.trim()}/balance`);
      setOrderBalance(bal);
      if (bal.outstanding > 0) setAmount(bal.outstanding.toFixed(2));
    } catch (e: unknown) {
      showToast((e as Error).message ?? 'Order not found', 'error');
      setOrderBalance(null);
    } finally { setLoadingBalance(false); }
  }

  function submitPayment() {
    if (!orderIdInput || !amount || !paymentMethod) { showToast('Fill all required fields', 'error'); return; }
    createMut.mutate({ orderId: parseInt(orderIdInput), amount: parseFloat(amount), paymentMethod, transactionReference: txRef || undefined });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex-shrink-0">
        {(['list', 'new'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-medium transition-colors ${tab === t ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {t === 'list' ? '💳 Payments' : '+ Record Payment'}
          </button>
        ))}
      </div>

      {/* ── Payments List ── */}
      {tab === 'list' && (
        <div className="flex-1 overflow-auto p-4 space-y-3">
          <div className="flex gap-2">
            <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setListPage(1); }}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All statuses</option>
              {['success','pending','failed','refunded','partially_refunded'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
            {isLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : (
              <table className="w-full text-sm min-w-[800px]">
                <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <tr>{['Reference','Order','Amount','Method','Status','Date','Actions'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {(listData?.items ?? []).map(pay => (
                    <>
                      <tr key={pay.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer" onClick={() => setExpandedId(expandedId === pay.id ? null : pay.id)}>
                        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{pay.paymentReference}</td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">#{pay.orderId}</td>
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">ETB {Number(pay.amount).toFixed(2)}</td>
                        <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">{METHOD_LABELS[pay.paymentMethod] ?? pay.paymentMethod}</td>
                        <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[pay.status] ?? ''}`}>{pay.status}</span></td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(pay.createdAt).toLocaleString()}</td>
                        <td className="px-4 py-3">
                          {canRefund(userRole) && pay.status !== 'failed' && pay.status !== 'refunded' && (
                            refundingId === pay.id ? (
                              <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                                <input type="number" value={refundAmount} onChange={e => setRefundAmount(e.target.value)} placeholder="Amount" className="text-xs px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white w-20" />
                                <input value={refundReason} onChange={e => setRefundReason(e.target.value)} placeholder="Reason" className="text-xs px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white w-24" />
                                <button onClick={() => refundMut.mutate({ id: pay.id, body: { refundAmount: parseFloat(refundAmount), reason: refundReason || 'Refund' } })} className="text-xs bg-red-600 text-white px-2 py-0.5 rounded">OK</button>
                                <button onClick={() => setRefundingId(null)} className="text-xs text-gray-500 px-1">✕</button>
                              </div>
                            ) : (
                              <button onClick={e => { e.stopPropagation(); setRefundingId(pay.id); setRefundAmount(Number(pay.amount).toFixed(2)); }} className="text-xs text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950 px-2 py-0.5 rounded transition-colors">Refund</button>
                            )
                          )}
                        </td>
                      </tr>
                      {expandedId === pay.id && (
                        <tr key={`${pay.id}-detail`}>
                          <td colSpan={7} className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 dark:text-gray-400">
                            {pay.transactionReference && <p>Tx Ref: {pay.transactionReference}</p>}
                            <p>Processed: {new Date(pay.processedAt).toLocaleString()}</p>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            )}
            {(!listData?.items || listData.items.length === 0) && !isLoading && <p className="text-center text-gray-400 text-sm py-8">No payments found</p>}
          </div>
          {listData && listData.totalPages > 1 && (
            <div className="flex justify-between items-center text-sm text-gray-500 dark:text-gray-400">
              <span>Page {listData.page} of {listData.totalPages}</span>
              <div className="flex gap-2">
                <button disabled={listPage <= 1} onClick={() => setListPage(p => p - 1)} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Prev</button>
                <button disabled={listPage >= listData.totalPages} onClick={() => setListPage(p => p + 1)} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Next</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Record Payment ── */}
      {tab === 'new' && (
        <div className="flex-1 overflow-auto p-4 pb-6 max-w-xl mx-auto w-full space-y-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Order</h3>
            <div className="flex gap-2">
              <input value={orderIdInput} onChange={e => setOrderIdInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadOrderBalance()} placeholder="Order ID (number)"
                className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <button onClick={loadOrderBalance} disabled={loadingBalance} className="px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50">
                {loadingBalance ? '...' : 'Load'}
              </button>
            </div>
            {orderBalance && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-sm space-y-1">
                <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Order Total</span><span className="font-medium text-gray-900 dark:text-white">ETB {orderBalance.orderTotal.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Paid</span><span className="text-green-600 dark:text-green-400">ETB {orderBalance.totalPaid.toFixed(2)}</span></div>
                {orderBalance.totalRefunded > 0 && <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Refunded</span><span className="text-amber-600 dark:text-amber-400">ETB {orderBalance.totalRefunded.toFixed(2)}</span></div>}
                <div className="flex justify-between font-semibold border-t border-gray-200 dark:border-gray-700 pt-1"><span className="text-gray-900 dark:text-white">Outstanding</span><span className={orderBalance.outstanding > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}>ETB {orderBalance.outstanding.toFixed(2)}</span></div>
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Payment Details</h3>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(METHOD_LABELS).map(([k, v]) => (
                <button key={k} onClick={() => setPaymentMethod(k)}
                  className={`py-2 text-xs rounded-lg transition-colors ${paymentMethod === k ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                  {v}
                </button>
              ))}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (ETB)</label>
              <input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Transaction Reference (optional)</label>
              <input value={txRef} onChange={e => setTxRef(e.target.value)} placeholder="Bank ref, mobile money code..."
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <button onClick={submitPayment} disabled={createMut.isPending || !orderIdInput || !amount}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm">
              {createMut.isPending ? 'Processing...' : 'Record Payment'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
