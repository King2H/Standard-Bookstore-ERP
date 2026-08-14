import { useState, useEffect } from 'react';
import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { useCurrency } from '../lib/useCurrency.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../components/Pagination.js';
import PaymentMethodTabs from '../components/PaymentMethodTabs.js';
import { paymentMethodLabel, type PaymentMethodCode } from '../lib/paymentMethods.js';

type Role = string;
interface PaymentsPageProps {
  userRole?: Role; userPermissions?: string[];
  /** Single Authoritative Payment Collection Workflow: Sales History's "View
   *  Payments" and Receivables' "Open in Payments" navigate here instead of
   *  offering their own Collect action. `orderId` + `sourceType` ('order' |
   *  'pos' | 'exchange_difference') pre-select and land on the Collect tab
   *  for that specific entity (matching listUnpaidOrders()'s id/source_type
   *  values — a receivable's own id for 'exchange_difference'). `tab:
   *  'history'` alone (no orderId) just opens Payment History; paired with
   *  orderId it also pre-filters History to that entity. */
  initialContext?: Record<string, string>;
}

interface Payment {
  id: string; paymentReference: string; orderId: string; amount: number;
  currency: string; paymentMethod: string; status: string;
  transactionReference: string | null; processedAt: string; createdAt: string;
  sourceType?: string; entityNumber?: string;
  /** Order status — used to hide Refund button for FULFILLED orders (req 4.3) */
  orderStatus?: string;
}
interface Refund { id: string; paymentId: string; orderId: string; refundAmount: number; reason: string; createdAt: string; }
interface PaymentListResponse { items: Payment[]; total: number; page: number; totalPages: number; }
interface OrderBalance { orderTotal: number; discountTotal: number; netPayable: number; totalPaid: number; totalRefunded: number; outstanding: number; paymentStatus: string; }
interface UnpaidOrder {
  id: string; orderNumber: string; customerName: string | null; customerCode: string | null;
  total: number; totalPaid: number; outstanding: number; paymentStatus: string;
  status: string; channel: string; createdAt: string;
  sourceType?: string;
}
interface UnpaidOrdersResponse { items: UnpaidOrder[]; total: number; page: number; totalPages: number; }
interface BankAccount {
  id: number; accountName: string; bankName: string; maskedAccountNumber: string; currency: string;
}

const STATUS_COLORS: Record<string, string> = {
  success: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  refunded: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  partially_refunded: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
};
const PAY_STATUS_COLORS: Record<string, string> = {
  unpaid: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  partial: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  paid: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  refunded: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};
// Payment method picker + labels — shared with POS/Exchange settlement via
// components/PaymentMethodTabs.js + lib/paymentMethods.js. Kept as the
// full method set already offered here (cash/bank/mobile/card/store
// credit/loyalty) — nothing added or removed, just unified with the other
// payment forms' presentation.
const COLLECT_METHODS: PaymentMethodCode[] = ['cash', 'bank', 'mobile', 'card', 'store_credit', 'loyalty_points'];

const canRefund = (r?: Role, perms?: string[]) => (perms?.includes('PROCESS_REFUND')) || ['Manager', 'Admin', 'Finance_Officer'].includes(r ?? '');

/** Task 13.1: Hide Void/Refund for payments on FULFILLED or COMPLETED orders.
 *  Post-fulfillment reversal must go through the Returns module, not a payment void. */
const isFulfilledOrder = (pay: Payment): boolean => {
  const s = (pay.orderStatus ?? '').toUpperCase();
  return s === 'FULFILLED' || s === 'COMPLETED';
};const canPay = (r?: Role, perms?: string[]) => (perms?.includes('PROCESS_PAYMENT')) || ['Sales', 'Manager', 'Admin', 'Finance_Officer'].includes(r ?? '');

type Tab = 'pending' | 'history' | 'collect';

export default function PaymentsPage({ userRole, userPermissions, initialContext = {} }: PaymentsPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const currency = useCurrency();
  const branchId = getCurrentBranchId() ?? 1;
  const [tab, setTab] = useState<Tab>(initialContext.tab === 'history' ? 'history' : 'pending');

  // Pending orders state
  const [pendingPage, setPendingPage] = useState(1);
  const [pendingPageSize, setPendingPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selectedOrder, setSelectedOrder] = useState<UnpaidOrder | null>(null);

  // Payment collection state
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<string>('cash');
  const [selectedBankAccountId, setSelectedBankAccountId] = useState<number | null>(null);
  const [txRef, setTxRef] = useState('');
  const [orderBalance, setOrderBalance] = useState<OrderBalance | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  // History state
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [refundingId, setRefundingId] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  // Deep-link filter from Sales History's "View Payments" — narrows History
  // to payments for one specific order/transaction. Cleared by the user via
  // the "✕ Clear filter" chip, independent of statusFilter.
  const [historyEntityFilter, setHistoryEntityFilter] = useState<string | null>(
    initialContext.tab === 'history' ? (initialContext.orderId ?? null) : null,
  );

  // ── Queries ──────────────────────────────────────────────────────────────────

  const { data: unpaidData, isLoading: unpaidLoading } = useQuery<UnpaidOrdersResponse>({
    queryKey: ['unpaid-orders', branchId, pendingPage, pendingPageSize],
    queryFn: () => api.get(`/payments/unpaid-orders?branchId=${branchId}&page=${pendingPage}&pageSize=${pendingPageSize}`),
    enabled: tab === 'pending',
    refetchInterval: 30_000,
  });

  const { data: historyData, isLoading: historyLoading } = useQuery<PaymentListResponse>({
    queryKey: ['payments-list', historyPage, historyPageSize, statusFilter, historyEntityFilter],
    queryFn: () => api.get(`/payments?page=${historyPage}&pageSize=${historyPageSize}${statusFilter ? `&status=${statusFilter}` : ''}${historyEntityFilter ? `&orderId=${historyEntityFilter}` : ''}`),
    enabled: tab === 'history',
  });

  // Deep-link pre-fill for the Collect tab: Sales History and Receivables
  // navigate here with a specific entity already known. Reuses the exact
  // same selectOrderForPayment() the Pending tab's own "Collect" button
  // calls — no separate/parallel pre-fill logic.
  useEffect(() => {
    if (!initialContext.orderId || !initialContext.sourceType || initialContext.tab === 'history') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<UnpaidOrdersResponse>(
          `/payments/unpaid-orders?branchId=${branchId}&entityId=${initialContext.orderId}&sourceType=${initialContext.sourceType}&pageSize=1`,
        );
        if (cancelled) return;
        if (res.items.length) {
          selectOrderForPayment(res.items[0]);
        } else {
          showToast('That item has no outstanding balance to collect (it may already be paid).', 'info');
        }
      } catch {
        if (!cancelled) showToast('Could not load that item for payment collection.', 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [initialContext.orderId, initialContext.sourceType]);

  // Fetch active bank accounts for this branch — only when Bank method is selected
  const { data: bankAccountsData } = useQuery<{ items: BankAccount[] }>({
    queryKey: ['bank-accounts-for-payment', branchId],
    queryFn: () => api.get(`/branches/${branchId}/bank-accounts`),
    enabled: paymentMethod === 'bank',
    staleTime: 5 * 60 * 1000,
  });
  const bankAccounts = bankAccountsData?.items ?? [];

  // Fetch customer store credit balance — only when Store Credit is selected and order has a customer
  const { data: customerData } = useQuery<{
    id: number; storeCreditBalance: number; loyaltyBalance: number; fullName: string;
  }>({
    queryKey: ['customer-for-payment', selectedOrder?.id],
    queryFn: async () => {
      // Get customer_id from the order
      const order = await api.get<{ customerId: number | null }>(`/orders/${selectedOrder!.id}`);
      if (!order.customerId) throw new Error('No customer on this order');
      return api.get(`/customers/${order.customerId}`);
    },
    enabled: (paymentMethod === 'store_credit' || paymentMethod === 'loyalty_points') && !!selectedOrder,
    staleTime: 30_000,
  });

  // ── Mutations ─────────────────────────────────────────────────────────────────

  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<Payment>('/payments', body),
    onSuccess: (p) => {
      showToast(`Payment ${p.paymentReference} recorded`, 'success');
      setAmount(''); setTxRef(''); setOrderBalance(null); setSelectedOrder(null); setSelectedBankAccountId(null);
      qc.invalidateQueries({ queryKey: ['unpaid-orders'] });
      qc.invalidateQueries({ queryKey: ['payments-list'] });
      qc.invalidateQueries({ queryKey: ['orders-list'] });
      qc.invalidateQueries({ queryKey: ['customer-for-payment'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      // Orders create their own receivable row (order_credit_sale) — keep
      // Receivables in sync in case the user navigates there next.
      qc.invalidateQueries({ queryKey: ['receivables'] });
      qc.invalidateQueries({ queryKey: ['receivables-summary'] });
      setTab('pending');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // POS credit-sale payment collection (routes to /api/pos/transactions/:id/payment)
  const posPayMut = useMutation({
    mutationFn: ({ txId, payments }: { txId: string; payments: { method: string; amount: number; reference?: string }[] }) =>
      api.post<unknown>(`/pos/transactions/${txId}/payment`, { payments }),
    onSuccess: () => {
      showToast('POS Credit Sale payment collected', 'success');
      setAmount(''); setTxRef(''); setOrderBalance(null); setSelectedOrder(null); setSelectedBankAccountId(null);
      qc.invalidateQueries({ queryKey: ['unpaid-orders'] });
      qc.invalidateQueries({ queryKey: ['payments-list'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['receivables'] });
      qc.invalidateQueries({ queryKey: ['receivables-summary'] });
      // Keeps Sales History's transaction list in sync (Module: Sales
      // History status column) if the user navigates back there.
      qc.invalidateQueries({ queryKey: ['pos-history'] });
      setTab('pending');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // Exchange-difference receivable collection — the one source type that has
  // no order/transaction row of its own, so it goes through the same
  // existing dispatcher Receivables' removed Collect button used to call
  // (POST /receivables/:id/collect -- unchanged; still branches internally
  // to payments/pos/receivables service functions per source type). id here
  // is the receivable's own id (see UnpaidOrder doc comment on
  // PaymentsPageProps).
  const receivableCollectMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.post(`/receivables/${id}/collect`, body),
    onSuccess: () => {
      showToast('Payment collected', 'success');
      setAmount(''); setTxRef(''); setOrderBalance(null); setSelectedOrder(null); setSelectedBankAccountId(null);
      qc.invalidateQueries({ queryKey: ['unpaid-orders'] });
      qc.invalidateQueries({ queryKey: ['payments-list'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['receivables'] });
      qc.invalidateQueries({ queryKey: ['receivables-summary'] });
      setTab('pending');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const refundMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.post<Refund>(`/payments/${id}/refund`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments-list'] });
      qc.invalidateQueries({ queryKey: ['unpaid-orders'] });
      showToast('Refund processed', 'success');
      setRefundingId(null); setRefundAmount(''); setRefundReason('');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // ── Handlers ──────────────────────────────────────────────────────────────────

  async function selectOrderForPayment(order: UnpaidOrder) {
    setSelectedOrder(order);
    setAmount(order.outstanding.toFixed(2));
    setPaymentMethod('cash');
    setSelectedBankAccountId(null);
    setTxRef('');

    // POS credit sales and exchange-difference receivables don't have a
    // backoffice /orders/:id/balance endpoint (that endpoint is order-table-
    // specific) — build the balance directly from the unpaid-orders row,
    // same as the POS branch.
    if (order.sourceType === 'pos' || order.sourceType === 'exchange_difference') {
      setOrderBalance({
        orderTotal: order.total,
        discountTotal: 0,
        netPayable: order.total,
        totalPaid: order.totalPaid,
        totalRefunded: 0,
        outstanding: order.outstanding,
        paymentStatus: order.paymentStatus,
      });
      setTab('collect');
      return;
    }

    setLoadingBalance(true);
    try {
      const raw = await api.get<OrderBalance>(`/orders/${order.id}/balance`);
      // The API returns { orderTotal, totalPaid, totalRefunded, outstanding, paymentStatus }.
      // discountTotal and netPayable are not included — provide safe defaults so .toFixed()
      // never crashes on undefined.
      const bal: OrderBalance = {
        orderTotal:    Number(raw.orderTotal    ?? order.total),
        discountTotal: Number(raw.discountTotal ?? 0),
        netPayable:    Number(raw.netPayable    ?? raw.orderTotal ?? order.total),
        totalPaid:     Number(raw.totalPaid     ?? order.totalPaid),
        totalRefunded: Number(raw.totalRefunded ?? 0),
        outstanding:   Number(raw.outstanding   ?? order.outstanding),
        paymentStatus: raw.paymentStatus ?? order.paymentStatus,
      };
      setOrderBalance(bal);
      setAmount(bal.outstanding.toFixed(2));
    } catch {
      setOrderBalance({ orderTotal: order.total, discountTotal: 0, netPayable: order.total, totalPaid: order.totalPaid, totalRefunded: 0, outstanding: order.outstanding, paymentStatus: order.paymentStatus });
    } finally {
      setLoadingBalance(false);
      setTab('collect');
    }
  }

  function submitPayment() {
    if (!selectedOrder || !amount || !paymentMethod) { showToast('Fill all required fields', 'error'); return; }
    if (paymentMethod === 'bank' && !selectedBankAccountId) {
      showToast('Select a bank account for bank transfer payments', 'error');
      return;
    }

    // POS Credit Sales are collected via the POS payment endpoint
    if (selectedOrder.sourceType === 'pos') {
      posPayMut.mutate({
        txId: selectedOrder.id,
        payments: [{ method: paymentMethod as 'cash' | 'bank' | 'mobile' | 'store_credit' | 'loyalty_points', amount: parseFloat(amount), reference: txRef || undefined }],
      });
      return;
    }

    // Exchange-difference receivables are collected via the receivables
    // dispatcher (id = the receivable's own id, not the exchange's)
    if (selectedOrder.sourceType === 'exchange_difference') {
      receivableCollectMut.mutate({
        id: selectedOrder.id,
        body: {
          amount: parseFloat(amount),
          paymentMethod,
          bankAccountId: paymentMethod === 'bank' ? selectedBankAccountId : undefined,
          notes: txRef || undefined,
        },
      });
      return;
    }

    createMut.mutate({
      orderId: parseInt(selectedOrder.id),
      amount: parseFloat(amount),
      paymentMethod,
      transactionReference: txRef || undefined,
      bankAccountId: paymentMethod === 'bank' ? selectedBankAccountId : undefined,
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex-shrink-0">
        <button onClick={() => setTab('pending')} className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-2 ${tab === 'pending' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
          ⏳ Pending Payments
          {unpaidData && unpaidData.total > 0 && (
            <span className="px-1.5 py-0.5 bg-red-500 text-white text-xs rounded-full leading-none font-semibold">{unpaidData.total}</span>
          )}
        </button>
        {selectedOrder && (
          <button onClick={() => setTab('collect')} className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'collect' ? 'border-b-2 border-green-600 text-green-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            💰 Collect — {selectedOrder.orderNumber}
          </button>
        )}
        <button onClick={() => setTab('history')} className={`px-4 py-2 text-sm font-medium transition-colors ${tab === 'history' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
          📋 Payment History
        </button>
      </div>

      {/* ── Pending Payments Tab ── */}
      {tab === 'pending' && (
        <div className="flex-1 overflow-auto p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Orders &amp; Credit Sales Awaiting Payment</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Select an order or POS credit sale to collect payment or record a partial payment.</p>
            </div>
            <span className="text-xs text-gray-400">{unpaidData?.total ?? 0} pending</span>
          </div>

          {unpaidLoading ? (
            <div className="p-8 text-center text-gray-400">Loading...</div>
          ) : !unpaidData?.items.length ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <span className="text-5xl mb-3">✅</span>
              <p className="text-gray-500 dark:text-gray-400 font-medium">No pending payments</p>
              <p className="text-xs text-gray-400 mt-1">All orders are fully paid.</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
              <table className="w-full text-sm min-w-[700px]">
                <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    {['Ref #', 'Customer', 'Channel', 'Total', 'Paid', 'Outstanding', 'Status', 'Date', 'Action'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {unpaidData.items.map(order => (
                    <tr key={order.id} className="hover:bg-blue-50/50 dark:hover:bg-blue-950/20 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {order.orderNumber}
                        {order.sourceType === 'pos' && (
                          <span className="ml-1.5 px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 text-[10px] rounded font-semibold">POS Credit</span>
                        )}
                        {order.sourceType === 'exchange_difference' && (
                          <span className="ml-1.5 px-1.5 py-0.5 bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 text-[10px] rounded font-semibold">Exchange</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                        {order.customerName ? (
                          <div>
                            <p className="font-medium text-gray-900 dark:text-white">{order.customerName}</p>
                            <p className="text-gray-400">{order.customerCode}</p>
                          </div>
                        ) : <span className="text-gray-400 italic">Walk-in</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 capitalize">{order.channel.replace('_', ' ')}</td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white whitespace-nowrap">{currency} {order.total.toFixed(2)}</td>
                      <td className="px-4 py-3 text-sm text-green-600 dark:text-green-400 whitespace-nowrap">{currency} {order.totalPaid.toFixed(2)}</td>
                      <td className="px-4 py-3 text-sm font-bold text-red-600 dark:text-red-400 whitespace-nowrap">{currency} {order.outstanding.toFixed(2)}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PAY_STATUS_COLORS[order.paymentStatus] ?? ''}`}>
                          {order.paymentStatus}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{new Date(order.createdAt).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        {canPay(userRole, userPermissions) && (
                          <button
                            onClick={() => selectOrderForPayment(order)}
                            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap">
                            💰 Collect
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {unpaidData && unpaidData.items.length > 0 && (
            <Pagination
              page={pendingPage} pageSize={pendingPageSize} total={unpaidData.total} totalPages={unpaidData.totalPages}
              onPageChange={setPendingPage} onPageSizeChange={makePageSizeHandler(setPendingPage, setPendingPageSize)}
              itemLabel="pending payment"
            />
          )}
        </div>
      )}

      {/* ── Collect Payment Tab ── */}
      {tab === 'collect' && selectedOrder && (
        <div className="flex-1 overflow-auto p-4 pb-6 max-w-xl mx-auto w-full space-y-4">
          {/* Order / POS Credit Sale summary */}
          <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide">
                  {selectedOrder.sourceType === 'pos' ? '🏷️ POS Credit Sale — Collecting Payment'
                    : selectedOrder.sourceType === 'exchange_difference' ? '🔁 Exchange Balance — Collecting Payment'
                    : 'Collecting Payment For'}
                </p>
                <p className="text-base font-bold text-blue-900 dark:text-blue-200 mt-0.5">{selectedOrder.orderNumber}</p>
                {selectedOrder.customerName && (
                  <p className="text-sm text-blue-700 dark:text-blue-300">{selectedOrder.customerName} ({selectedOrder.customerCode})</p>
                )}
              </div>
              <button onClick={() => { setSelectedOrder(null); setOrderBalance(null); setSelectedBankAccountId(null); setTab('pending'); }}
                className="text-blue-400 hover:text-blue-600 text-sm">✕ Cancel</button>
            </div>
            {loadingBalance ? (
              <div className="mt-3 text-xs text-blue-500">Loading balance...</div>
            ) : orderBalance && (
              <div className="mt-3 space-y-1 text-sm border-t border-blue-200 dark:border-blue-800 pt-3">
                <div className="flex justify-between"><span className="text-blue-600 dark:text-blue-400">Order Total</span><span className="font-medium text-blue-900 dark:text-blue-200">{currency} {orderBalance.orderTotal.toFixed(2)}</span></div>
                {orderBalance.discountTotal > 0 && <div className="flex justify-between"><span className="text-blue-600 dark:text-blue-400">Discount</span><span className="text-green-600 dark:text-green-400">-{currency} {orderBalance.discountTotal.toFixed(2)}</span></div>}
                <div className="flex justify-between"><span className="text-blue-600 dark:text-blue-400">Net Payable</span><span className="font-medium text-blue-900 dark:text-blue-200">{currency} {orderBalance.netPayable.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-blue-600 dark:text-blue-400">Already Paid</span><span className="text-green-600 dark:text-green-400">{currency} {orderBalance.totalPaid.toFixed(2)}</span></div>
                {orderBalance.totalRefunded > 0 && <div className="flex justify-between"><span className="text-blue-600 dark:text-blue-400">Refunded</span><span className="text-amber-600 dark:text-amber-400">{currency} {orderBalance.totalRefunded.toFixed(2)}</span></div>}
                <div className="flex justify-between font-bold border-t border-blue-200 dark:border-blue-800 pt-1">
                  <span className="text-blue-900 dark:text-blue-200">Outstanding</span>
                  <span className="text-red-600 dark:text-red-400">{currency} {orderBalance.outstanding.toFixed(2)}</span>
                </div>
              </div>
            )}
          </div>

          {/* Payment form — shared picker, same as POS/Exchange settlement */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Payment Method</h3>
            <PaymentMethodTabs
              methods={COLLECT_METHODS}
              value={paymentMethod}
              onChange={m => { setPaymentMethod(m); setSelectedBankAccountId(null); }}
              columns={3}
            />

            {/* Bank account selector — shown only when Bank Transfer is selected */}
            {paymentMethod === 'bank' && (
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Bank Account <span className="text-red-500">*</span>
                </label>
                {bankAccounts.length === 0 ? (
                  <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-700 dark:text-amber-300">
                    ⚠️ No active bank accounts registered for this branch.
                    <a href="#" onClick={e => { e.preventDefault(); }} className="ml-1 underline">Add one in Bank Accounts.</a>
                  </div>
                ) : (
                  <select
                    value={selectedBankAccountId ?? ''}
                    onChange={e => setSelectedBankAccountId(e.target.value ? parseInt(e.target.value) : null)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">— Select bank account —</option>
                    {bankAccounts.map(ba => (
                      <option key={ba.id} value={ba.id}>
                        {ba.bankName} — {ba.accountName} ({ba.maskedAccountNumber}) · {ba.currency}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {/* Store credit info — shown when Store Credit is selected */}
            {paymentMethod === 'store_credit' && (
              <div className={`p-3 rounded-lg text-xs border ${
                !selectedOrder?.customerName
                  ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
                  : customerData
                  ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300'
                  : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500'
              }`}>
                {!selectedOrder?.customerName ? (
                  '⚠️ This order has no customer. Store credit requires a linked customer.'
                ) : customerData ? (
                  <div className="space-y-0.5">
                    <p className="font-medium">{customerData.fullName}</p>
                    <p>Available Store Credit: <strong>{currency} {Number(customerData.storeCreditBalance).toFixed(2)}</strong></p>
                    {parseFloat(amount || '0') > customerData.storeCreditBalance && (
                      <p className="text-red-600 dark:text-red-400 font-medium">⚠️ Requested amount exceeds available balance</p>
                    )}
                  </div>
                ) : (
                  'Loading customer balance...'
                )}
              </div>
            )}

            {/* Loyalty points info — shown when Loyalty Points is selected */}
            {paymentMethod === 'loyalty_points' && (
              <div className={`p-3 rounded-lg text-xs border ${
                !selectedOrder?.customerName
                  ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
                  : customerData
                  ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-300'
                  : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500'
              }`}>
                {!selectedOrder?.customerName ? (
                  '⚠️ This order has no customer. Loyalty points require a linked customer.'
                ) : customerData ? (
                  <div className="space-y-0.5">
                    <p className="font-medium">{customerData.fullName}</p>
                    <p>Available Points: <strong>{Number(customerData.loyaltyBalance).toFixed(0)} pts</strong> ({currency} {Number(customerData.loyaltyBalance).toFixed(2)} value)</p>
                    {parseFloat(amount || '0') > customerData.loyaltyBalance && (
                      <p className="text-red-600 dark:text-red-400 font-medium">⚠️ Requested amount exceeds available points</p>
                    )}
                  </div>
                ) : (
                  'Loading customer balance...'
                )}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{`Amount (${currency})`}</label>
              <div className="flex gap-2">
                <input type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                {orderBalance && orderBalance.outstanding > 0 && (
                  <button onClick={() => setAmount(orderBalance.outstanding.toFixed(2))}
                    className="px-3 py-2 text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors whitespace-nowrap">
                    Full {currency} {orderBalance.outstanding.toFixed(2)}
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Transaction Reference (optional)</label>
              <input value={txRef} onChange={e => setTxRef(e.target.value)} placeholder="Bank ref, mobile money code..."
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <button onClick={submitPayment} disabled={
              (createMut.isPending || posPayMut.isPending || receivableCollectMut.isPending) ||
              !amount ||
              parseFloat(amount) <= 0 ||
              (paymentMethod === 'bank' && !selectedBankAccountId) ||
              (paymentMethod === 'store_credit' && (!selectedOrder?.customerName || (customerData != null && parseFloat(amount) > customerData.storeCreditBalance))) ||
              (paymentMethod === 'loyalty_points' && (!selectedOrder?.customerName || (customerData != null && parseFloat(amount) > customerData.loyaltyBalance)))
            }
              className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm">
              {(createMut.isPending || posPayMut.isPending || receivableCollectMut.isPending) ? 'Processing...' : `✓ Record Payment — ${currency} ${parseFloat(amount || '0').toFixed(2)}`}
            </button>
          </div>
        </div>
      )}

      {/* ── Payment History Tab ── */}
      {tab === 'history' && (
        <div className="flex-1 overflow-auto p-4 space-y-3">
          <div className="flex gap-2 items-center flex-wrap">
            <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setHistoryPage(1); }}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All statuses</option>
              {['success', 'pending', 'failed', 'refunded', 'partially_refunded'].map(s => (
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              ))}
            </select>
            {historyEntityFilter && (
              <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded-lg">
                Filtered to one sale
                <button onClick={() => { setHistoryEntityFilter(null); setHistoryPage(1); }} className="text-blue-400 hover:text-blue-600 dark:hover:text-blue-200" title="Clear filter">✕</button>
              </span>
            )}
          </div>

          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
            {historyLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : (
              <table className="w-full text-sm min-w-[800px]">
                <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <tr>{['Reference', 'Order', 'Amount', 'Method', 'Status', 'Date', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {(historyData?.items ?? []).map(pay => (
                    <React.Fragment key={pay.id}>
                      <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer" onClick={() => setExpandedId(expandedId === pay.id ? null : pay.id)}>
                        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                          {pay.paymentReference}
                          {pay.sourceType === 'pos' && (
                            <span className="ml-1.5 px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 text-[10px] rounded font-semibold">POS</span>
                          )}
                          {pay.sourceType === 'exchange' && (
                            <span className="ml-1.5 px-1.5 py-0.5 bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 text-[10px] rounded font-semibold">Exchange</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">{pay.entityNumber ?? `#${pay.orderId}`}</td>
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">{currency} {Number(pay.amount).toFixed(2)}</td>
                        <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">{paymentMethodLabel(pay.paymentMethod)}</td>
                        <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[pay.status] ?? ''}`}>{pay.status}</span></td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(pay.createdAt).toLocaleString()}</td>
                        <td className="px-4 py-3">
                          {/* POS payments cannot be refunded here — use POS Returns flow.
                              Exchange-difference collections aren't order_payments rows
                              either, so this generic refund endpoint doesn't apply to them. */}
                          {/* Task 13.1: Also hide for FULFILLED/COMPLETED orders — use Returns module */}
                          {canRefund(userRole, userPermissions) && pay.status !== 'failed' && pay.status !== 'refunded' && pay.sourceType !== 'pos' && pay.sourceType !== 'exchange' && !isFulfilledOrder(pay) && (
                            refundingId === pay.id ? (
                              <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                                <input type="number" value={refundAmount} onChange={e => setRefundAmount(e.target.value)} placeholder="Amount"
                                  className="text-xs px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white w-20" />
                                <input value={refundReason} onChange={e => setRefundReason(e.target.value)} placeholder="Reason"
                                  className="text-xs px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white w-24" />
                                <button onClick={() => refundMut.mutate({ id: pay.id, body: { refundAmount: parseFloat(refundAmount), reason: refundReason || 'Refund' } })}
                                  className="text-xs bg-red-600 text-white px-2 py-0.5 rounded">OK</button>
                                <button onClick={() => setRefundingId(null)} className="text-xs text-gray-500 px-1">✕</button>
                              </div>
                            ) : (
                              <button onClick={e => { e.stopPropagation(); setRefundingId(pay.id); setRefundAmount(Number(pay.amount).toFixed(2)); }}
                                className="text-xs text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950 px-2 py-0.5 rounded transition-colors">
                                Refund
                              </button>
                            )
                          )}
                          {pay.sourceType === 'pos' && pay.status !== 'refunded' && (
                            <span className="text-xs text-gray-400 italic">POS Returns only</span>
                          )}
                          {pay.sourceType === 'exchange' && (
                            <span className="text-xs text-gray-400 italic">Manage via Exchanges</span>
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
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            )}
            {(!historyData?.items || historyData.items.length === 0) && !historyLoading && (
              <p className="text-center text-gray-400 text-sm py-8">No payments found</p>
            )}
            {historyData && (
              <Pagination
                page={historyPage} pageSize={historyPageSize} total={historyData.total} totalPages={historyData.totalPages}
                onPageChange={setHistoryPage} onPageSizeChange={makePageSizeHandler(setHistoryPage, setHistoryPageSize)}
                itemLabel="payment"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
