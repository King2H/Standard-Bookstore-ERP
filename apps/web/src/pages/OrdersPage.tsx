import { useState } from 'react';
import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../components/Pagination.js';
import { useCurrency } from '../lib/useCurrency.js';

type Role = string;
interface OrdersPageProps {
  userRole?: Role; userPermissions?: string[]; initialContext?: Record<string, string>;
  /** "View Payments" (unpaid/partial or credit orders) deep-links into the
   *  Payments module's Collect tab, pre-selected for that order — same
   *  pattern as POS Sales History's "View Payments". */
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}

interface OrderLine { id: string; bookId: number; bookTitle: string; quantity: number; unitPrice: number; totalPrice: number; qtyReserved: number; qtyFulfilled: number; isBackordered: boolean; }
interface Order {
  id: string; orderNumber: string; customerId: number | null; branchId: number;
  channel: string; status: string; paymentStatus: string; currency: string;
  saleType?: 'cash_sale' | 'credit_sale';
  subtotal: number; total: number; cancelReason: string | null;
  createdAt: string; lineItems?: OrderLine[];
  allowedActions?: string[];
  paymentMethod?: string | null;
  dueDate?: string | null;
}
interface OrderListResponse { items: Order[]; total: number; page: number; totalPages: number; }
interface Customer { id: number; customerCode: string; fullName: string; }
interface BookResult { id: number; title: string; isbn: string; defaultPrice: number | null; branchPrice: number | null; stockQuantity?: number | null; availability?: { locationId: number; locationName: string | null; onHand: number; reserved: number; available: number; } | null; }

// Lifecycle status colours — covers both legacy and new values
const STATUS_COLORS: Record<string, string> = {
  // Legacy (backward compat)
  Pending:     'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  Confirmed:   'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  In_Progress: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  Fulfilled:   'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  Cancelled:   'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  // New lifecycle values
  DRAFT:       'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  CONFIRMED:   'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  PAID:        'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
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

// Action button styles
const ACTION_STYLES: Record<string, string> = {
  confirm:     'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 hover:bg-blue-200',
  fulfill:     'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 hover:bg-purple-200',
  complete:    'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 hover:bg-green-200',
  cancel:      'text-red-600 hover:bg-red-50 dark:hover:bg-red-950',
  print:       'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
  // legacy
  progress:    'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 hover:bg-purple-200',
};
const ACTION_LABELS: Record<string, string> = {
  confirm: 'Confirm', fulfill: 'Fulfill',
  complete: 'Complete', cancel: 'Cancel', print: '🖨 Print', progress: 'Progress',
};

const canCreate = (r?: Role, perms?: string[]) =>
  (perms && perms.includes('CREATE_SALE')) ||
  ['Sales', 'Manager', 'Admin', 'Super_Admin'].includes(r ?? '');

// Payment Mode Capture: the 4 methods this ticket asks for, captured at cash-sale
// confirmation. Vocabulary matches order_payments.payment_method's existing CHECK
// constraint ('mobile' = Telebirr, 'store_credit' = Store Credit) — no new values.
const CASH_PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: '💵 Cash', bank: '🏦 Bank Transfer', mobile: '📱 Telebirr', store_credit: '🎁 Store Credit',
};

type Tab = 'list' | 'new';

export default function OrdersPage({ userRole, userPermissions = [], initialContext = {}, onNavigate }: OrdersPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const currency = useCurrency();
  const [tab, setTab] = useState<Tab>('list');
  const branchId = getCurrentBranchId() ?? 1;

  // List state
  const [listPage, setListPage] = useState(1);
  const [listPageSize, setListPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [statusFilter, setStatusFilter] = useState(initialContext.status ?? '');
  // Module 6: dashboard drill-downs (Monthly Sales KPI) pass a date range —
  // wire it through instead of silently discarding it.
  const [dateFromFilter, setDateFromFilter] = useState(initialContext.dateFrom ?? '');
  const [dateToFilter, setDateToFilter] = useState(initialContext.dateTo ?? '');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmDueDate, setConfirmDueDate] = useState('');
  const [confirmPaymentMethod, setConfirmPaymentMethod] = useState('');

  // New order state
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [saleType, setSaleType] = useState<'cash_sale' | 'credit_sale'>('cash_sale');
  const [channel, setChannel] = useState<'in_store' | 'phone' | 'online'>('in_store');
  const [bookSearch, setBookSearch] = useState('');
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [orderItems, setOrderItems] = useState<Array<{ bookId: number; bookTitle: string; quantity: number; unitPrice: number; discountPct: number; discountType: string; discountMode: string; availableStock: number | null; }>>([]);

  // Queries
  const { data: listData, isLoading } = useQuery<OrderListResponse>({
    queryKey: ['orders-list', listPage, listPageSize, branchId, statusFilter, dateFromFilter, dateToFilter],
    queryFn: () => api.get(`/orders?branchId=${branchId}&page=${listPage}&pageSize=${listPageSize}${statusFilter ? `&status=${statusFilter}` : ''}${dateFromFilter ? `&dateFrom=${dateFromFilter}` : ''}${dateToFilter ? `&dateTo=${dateToFilter}` : ''}`),
    enabled: tab === 'list',
  });

  const { data: customerResults } = useQuery<{ items: Customer[] }>({
    queryKey: ['order-customers', customerSearch],
    queryFn: () => api.get(`/customers?q=${encodeURIComponent(customerSearch)}&pageSize=5`),
    enabled: customerSearch.length > 1,
  });

  const { data: bookResults } = useQuery<{ items: BookResult[] }>({
    queryKey: ['order-books', bookSearch, branchId, selectedLocationId],
    queryFn: () => api.get(`/books/with-availability?q=${encodeURIComponent(bookSearch)}&pageSize=8&branchId=${branchId}${selectedLocationId ? `&locationId=${selectedLocationId}` : ''}`),
    enabled: bookSearch.length > 1,
  });

  // Fetch branch locations so we can pass locationId to book search for stock availability
  const { data: branchLocations } = useQuery<{ items: Array<{ id: number; name: string; isDefaultFulfillment: boolean }> }>({
    queryKey: ['branch-locations-orders', branchId],
    queryFn: () => api.get(`/branches/${branchId}/locations`),
    enabled: branchId > 0,
    staleTime: 60_000,
  });
  // Auto-select the default fulfillment location when locations load
  const effectiveLocationId = selectedLocationId ?? branchLocations?.items?.find(l => l.isDefaultFulfillment)?.id ?? branchLocations?.items?.[0]?.id ?? null;

  // Mutations
  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<Order>('/orders', body),
    onSuccess: (o) => { showToast(`Order ${o.orderNumber} created`, 'success'); setTab('list'); setOrderItems([]); setSelectedCustomer(null); qc.invalidateQueries({ queryKey: ['orders-list'] }); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const actionMut = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) => api.post<Order>(`/orders/${id}/${action}`, body),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['orders-list'] });
      // Refresh expanded order detail so reservation/fulfillment state updates immediately
      qc.invalidateQueries({ queryKey: ['order-detail', variables.id] });
      // Inventory quantities change on confirm (deducted+reserved) and cancel (restored),
      // so invalidate inventory cache so stock pages reflect current truth.
      qc.invalidateQueries({ queryKey: ['inventory'] });
      // Also invalidate book availability queries so stock underneath search updates
      qc.invalidateQueries({ queryKey: ['order-books'] });
      showToast('Order updated', 'success');
      setCancelingId(null);
      setCancelReason('');
      setConfirmingId(null);
      setConfirmDueDate('');
      setConfirmPaymentMethod('');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // Module 9: admin-only cleanup for Draft/Cancelled orders (service layer
  // enforces the status gate + dependency checks — see orders.service.ts
  // deleteOrder()).
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/orders/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders-list'] });
      showToast('Order deleted', 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  function addItem(book: BookResult) {
    const price = book.branchPrice ?? book.defaultPrice ?? 0;
    const availableStock = book.availability?.available ?? null;
    const existing = orderItems.find(i => i.bookId === book.id);
    if (existing) {
      if (availableStock != null && existing.quantity >= availableStock) {
        showToast(`Only ${availableStock} in stock for "${book.title}"`, 'error');
        return;
      }
      setOrderItems(items => items.map(i => i.bookId === book.id ? { ...i, quantity: i.quantity + 1 } : i));
    } else {
      if (availableStock != null && availableStock <= 0) {
        showToast(`"${book.title}" is out of stock`, 'error');
        return;
      }
      setOrderItems(items => [...items, { bookId: book.id, bookTitle: book.title, quantity: 1, unitPrice: price, discountPct: 0, discountType: 'Normal', discountMode: 'Percentage', availableStock }]);
    }
    setBookSearch('');
  }

  function submitOrder() {
    if (orderItems.length === 0) { showToast('Add at least one item', 'error'); return; }
    if (saleType === 'credit_sale' && !selectedCustomer) {
      showToast('Credit sales require a customer', 'error');
      return;
    }
    createMut.mutate({
      customerId: selectedCustomer?.id ?? null,
      channel,
      saleType,
      locationId: effectiveLocationId ?? undefined,
      items: orderItems.map(i => ({
        bookId: i.bookId,
        quantity: i.quantity,
        discountPct: i.discountMode === 'Percentage' ? i.discountPct : undefined,
        discountAmount: i.discountMode === 'Amount' ? i.discountPct : undefined,
        discountType: i.discountType,
        discountMode: i.discountMode,
      })),
    });
  }

  const subtotal = orderItems.reduce((s, i) => {
    const lineTotal = i.discountMode === 'Percentage'
      ? i.unitPrice * i.quantity * (1 - i.discountPct / 100)
      : Math.max(0, i.unitPrice * i.quantity - i.discountPct);
    return s + lineTotal;
  }, 0);
  // userPermissions available for future fine-grained checks
  void userPermissions;

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex-shrink-0">
        {/* Layout standardization: Operation (New Order) tab button shown
            before History (Orders) — visual order only. Default active tab
            stays 'list' so sidebar nav and Dashboard drill-downs (Module 6)
            still land on the filtered order list, unchanged. */}
        {(['new', 'list'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-medium transition-colors ${tab === t ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {t === 'list' ? '📋 Orders' : '+ New Order'}
          </button>
        ))}
      </div>

      {/* ── Orders List ── */}
      {tab === 'list' && (
        <div className="flex-1 overflow-auto p-4 space-y-3">
          <div className="flex gap-2 items-center flex-wrap">
            <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setListPage(1); }}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All statuses</option>
              {/* Matches the Dashboard's Pending Orders drill-down exactly (Module 6/
                  hotfix) — without this explicit option, arriving here with that
                  filter pre-applied left the <select> showing "All statuses" (no
                  option matched the comma-joined value), which looked like the
                  drill-down hadn't applied any filter even though it had. */}
              <option value="Confirmed,In_Progress,CONFIRMED,PAID">Pending Fulfillment (Confirmed/Paid)</option>
              {['DRAFT','CONFIRMED','PAID','FULFILLED','COMPLETED','CANCELLED',
                'Pending','Confirmed','In_Progress','Fulfilled','Cancelled'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <input type="date" value={dateFromFilter} onChange={e => { setDateFromFilter(e.target.value); setListPage(1); }}
              className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <span className="text-xs text-gray-400">to</span>
            <input type="date" value={dateToFilter} onChange={e => { setDateToFilter(e.target.value); setListPage(1); }}
              className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {(statusFilter || dateFromFilter || dateToFilter) && (
              <button onClick={() => { setStatusFilter(''); setDateFromFilter(''); setDateToFilter(''); setListPage(1); }}
                className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                Clear
              </button>
            )}
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
            {isLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : (
              <table className="w-full text-sm min-w-[800px]">
                <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <tr>{['Order #','Channel','Status','Payment','Total','Date','Actions'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {(listData?.items ?? []).map(order => (
                    <React.Fragment key={order.id}>
                      <tr key={order.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer" onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}>
                        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{order.orderNumber}</td>
                        <td className="px-4 py-3 text-xs capitalize text-gray-600 dark:text-gray-400">{order.channel.replace('_', ' ')}</td>
                        <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[order.status] ?? ''}`}>{order.status}</span></td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 flex-wrap">
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PAY_COLORS[order.paymentStatus] ?? ''}`}>{order.paymentStatus}</span>
                            {order.saleType === 'credit_sale' && <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">Credit</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">{currency} {Number(order.total).toFixed(2)}</td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(order.createdAt).toLocaleString()}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 flex-wrap">
                            {/* Render buttons from allowedActions returned by the API */}
                            {(order.allowedActions ?? []).map(action => {
                              if (action === 'cancel') {
                                return cancelingId === order.id ? (
                                  <div key="cancel-confirm" className="flex gap-1" onClick={e => e.stopPropagation()}>
                                    <input value={cancelReason} onChange={e => setCancelReason(e.target.value)} placeholder="Reason..." className="text-xs px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white w-28" />
                                    <button onClick={() => actionMut.mutate({ id: order.id, action: 'cancel', body: { reason: cancelReason || 'No reason' } })} className="text-xs bg-red-600 text-white px-2 py-0.5 rounded">OK</button>
                                    <button onClick={() => setCancelingId(null)} className="text-xs text-gray-500 px-1">✕</button>
                                  </div>
                                ) : (
                                  <button key="cancel" onClick={e => { e.stopPropagation(); setCancelingId(order.id); }}
                                    className={`text-xs px-2 py-0.5 rounded transition-colors ${ACTION_STYLES.cancel}`}>
                                    Cancel
                                  </button>
                                );
                              }
                              // Module 4: credit_sale orders must carry a due date on the
                              // receivable created at confirm — prompt for it inline instead
                              // of firing the plain confirm action.
                              if (action === 'confirm' && order.saleType === 'credit_sale') {
                                return confirmingId === order.id ? (
                                  <div key="confirm-credit" className="flex gap-1" onClick={e => e.stopPropagation()}>
                                    <input type="date" value={confirmDueDate} min={new Date().toISOString().slice(0, 10)} onChange={e => setConfirmDueDate(e.target.value)}
                                      className="text-xs px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                                    <button
                                      disabled={!confirmDueDate}
                                      onClick={() => actionMut.mutate({ id: order.id, action: 'confirm', body: { dueDate: confirmDueDate } })}
                                      className="text-xs bg-blue-600 disabled:opacity-40 text-white px-2 py-0.5 rounded">OK</button>
                                    <button onClick={() => { setConfirmingId(null); setConfirmDueDate(''); }} className="text-xs text-gray-500 px-1">✕</button>
                                  </div>
                                ) : (
                                  <button key="confirm-credit-open" onClick={e => { e.stopPropagation(); setConfirmingId(order.id); setConfirmDueDate(''); }}
                                    className={`text-xs px-2 py-0.5 rounded transition-colors ${ACTION_STYLES.confirm}`}>
                                    Confirm (set due date)
                                  </button>
                                );
                              }
                              // Payment Mode Capture: a cash order's payment method is
                              // recorded automatically at confirm — prompt for it inline,
                              // mirroring the credit_sale due-date prompt above.
                              if (action === 'confirm' && order.saleType === 'cash_sale') {
                                return confirmingId === order.id ? (
                                  <div key="confirm-cash" className="flex gap-1" onClick={e => e.stopPropagation()}>
                                    <select value={confirmPaymentMethod} onChange={e => setConfirmPaymentMethod(e.target.value)}
                                      className="text-xs px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
                                      <option value="">Payment method…</option>
                                      {Object.entries(CASH_PAYMENT_METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                    </select>
                                    <button
                                      disabled={!confirmPaymentMethod}
                                      onClick={() => actionMut.mutate({ id: order.id, action: 'confirm', body: { paymentMethod: confirmPaymentMethod } })}
                                      className="text-xs bg-blue-600 disabled:opacity-40 text-white px-2 py-0.5 rounded">OK</button>
                                    <button onClick={() => { setConfirmingId(null); setConfirmPaymentMethod(''); }} className="text-xs text-gray-500 px-1">✕</button>
                                  </div>
                                ) : (
                                  <button key="confirm-cash-open" onClick={e => { e.stopPropagation(); setConfirmingId(order.id); setConfirmPaymentMethod(''); }}
                                    className={`text-xs px-2 py-0.5 rounded transition-colors ${ACTION_STYLES.confirm}`}>
                                    Confirm (set payment method)
                                  </button>
                                );
                              }
                              // 'pay' action removed — payment is collected via Finance → Payments
                              if (action === 'print') {
                                return (
                                  <button key="print" onClick={e => { e.stopPropagation(); window.print(); }}
                                    className={`text-xs px-2 py-0.5 rounded transition-colors ${ACTION_STYLES.print}`}>
                                    {ACTION_LABELS.print}
                                  </button>
                                );
                              }
                              return (
                                <button key={action} onClick={e => { e.stopPropagation(); actionMut.mutate({ id: order.id, action }); }}
                                  className={`text-xs px-2 py-0.5 rounded transition-colors ${ACTION_STYLES[action] ?? 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                                  {ACTION_LABELS[action] ?? action}
                                </button>
                              );
                            })}
                            {/* View Payments: deep-links into Payments' Collect tab,
                                pre-selected for this order — same pattern as POS Sales
                                History's "View Payments". Only offered when there's an
                                outstanding balance to collect (paymentStatus unpaid/
                                partial, which is exactly what credit_sale orders carry
                                until settled — cash_sale orders are paid in full at
                                confirm and never reach this state). */}
                            {(order.paymentStatus === 'unpaid' || order.paymentStatus === 'partial') && (
                              <button
                                onClick={e => { e.stopPropagation(); onNavigate?.('payments', { orderId: order.id, sourceType: 'order' }); }}
                                className="text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 px-2 py-0.5 rounded-lg font-semibold transition-colors whitespace-nowrap"
                              >View Payments</button>
                            )}
                            {/* Module 11 cleanup: removed a "legacy orders without
                                allowedActions" fallback block that lived here. It was
                                dead code — every response that can populate this list
                                (GET /orders, GET /orders/:id) has always attached
                                allowedActions server-side via computeOrderAllowedActions()
                                (orders.routes.ts) since that field was introduced, so
                                order.allowedActions is never undefined in practice. The
                                fallback had also drifted out of date with real fixes made
                                since: it used only the legacy status vocabulary
                                ('Pending'/'Confirmed'), and its 'confirm' button called
                                actionMut with no body, which would violate Module 4's
                                mandatory-due-date-for-credit-orders confirm requirement had
                                it ever actually rendered. */}
                            {/* Module 9: admin-only delete for Draft/Cancelled orders. */}
                            {userRole === 'Admin' && ['DRAFT', 'Pending', 'CANCELLED', 'Cancelled'].includes(order.status) && (
                              <button
                                onClick={e => { e.stopPropagation(); if (confirm(`Permanently delete order ${order.orderNumber}? This cannot be undone.`)) deleteMut.mutate(order.id); }}
                                disabled={deleteMut.isPending}
                                className="text-xs px-2 py-0.5 rounded transition-colors text-red-600 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
                              >
                                🗑 Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expandedId === order.id && (
                        <tr key={`${order.id}-detail`}>
                          <td colSpan={7} className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50">
                            <OrderDetailLoader orderId={order.id} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            )}
            {(!listData?.items || listData.items.length === 0) && !isLoading && <p className="text-center text-gray-400 text-sm py-8">No orders found</p>}
            {listData && (
              <Pagination
                page={listPage} pageSize={listPageSize} total={listData.total} totalPages={listData.totalPages}
                onPageChange={setListPage} onPageSizeChange={makePageSizeHandler(setListPage, setListPageSize)}
                itemLabel="order"
              />
            )}
          </div>
        </div>
      )}

      {/* ── New Order ── */}
      {tab === 'new' && canCreate(userRole, userPermissions) && (
        <div className="flex-1 overflow-auto p-4 pb-6 max-w-2xl mx-auto w-full space-y-4">
          {/* Customer */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Customer (optional)</h3>
            {selectedCustomer ? (
              <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-950/30 rounded-lg px-3 py-2">
                <span className="text-sm text-blue-700 dark:text-blue-300">{selectedCustomer.fullName} ({selectedCustomer.customerCode})</span>
                <button onClick={() => setSelectedCustomer(null)} className="text-gray-400 hover:text-red-500 text-sm">×</button>
              </div>
            ) : (
              <div className="relative">
                <input value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} placeholder="Search customer..."
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                {(customerResults?.items ?? []).length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10">
                    {(customerResults?.items ?? []).map(c => (
                      <button key={c.id} onClick={() => { setSelectedCustomer(c); setCustomerSearch(''); }} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                        <span className="font-medium text-gray-900 dark:text-white">{c.fullName}</span>
                        <span className="text-gray-500 dark:text-gray-400 ml-2 text-xs">{c.customerCode}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sale Type */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Sale Type</h3>
            <div className="flex gap-2">
              {([['cash_sale', '💵 Cash Sale'], ['credit_sale', '📋 Credit Sale']] as const).map(([v, label]) => (
                <button key={v} onClick={() => setSaleType(v)}
                  className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${saleType === v ? (v === 'credit_sale' ? 'bg-amber-600 text-white' : 'bg-green-600 text-white') : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                  {label}
                </button>
              ))}
            </div>
            {saleType === 'credit_sale' && !selectedCustomer && (
              <p className="text-xs text-amber-600 dark:text-amber-400">⚠ Credit sales require a customer — please select one above.</p>
            )}
          </div>

          {/* Channel */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Channel</h3>
            <div className="flex gap-2">
              {(['in_store','phone','online'] as const).map(c => (
                <button key={c} onClick={() => setChannel(c)} className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${channel === c ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                  {c.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>

          {/* Location */}
          {branchLocations && branchLocations.items.length > 1 && (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Fulfillment Location</h3>
              <select
                value={selectedLocationId ?? effectiveLocationId ?? ''}
                onChange={e => setSelectedLocationId(e.target.value ? Number(e.target.value) : null)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {branchLocations.items.map(l => (
                  <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>
                ))}
              </select>
            </div>
          )}

          {/* Items */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Items</h3>
            <div className="relative">
              <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="Search books to add..."
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              {(bookResults?.items ?? []).length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
                  {(bookResults?.items ?? []).map(b => (
                    <button key={b.id} onClick={() => addItem(b)}
                      disabled={b.availability != null && b.availability.available === 0}
                      className={`w-full text-left px-3 py-2 text-sm transition-colors border-b border-gray-100 dark:border-gray-800 last:border-0 ${b.availability != null && b.availability.available === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-50 dark:hover:bg-blue-950/30'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium text-gray-900 dark:text-white truncate">{b.title}</p>
                        {b.availability != null && (
                          <span className={`text-xs font-semibold flex-shrink-0 px-1.5 py-0.5 rounded-full ${b.availability.available === 0 ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400' : b.availability.available <= 3 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'}`}>
                            {b.availability.available === 0 ? 'Out of stock' : `${b.availability.available} avail`}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{b.isbn} · {currency} {(b.branchPrice ?? b.defaultPrice ?? 0).toFixed(2)}</p>
                      {b.availability != null ? (
                        <p className="text-xs text-gray-400 mt-0.5">
                          📍 {b.availability.locationName ?? 'Location'} · On hand: {b.availability.onHand} · Reserved: {b.availability.reserved} · Available: {b.availability.available}
                        </p>
                      ) : b.stockQuantity != null && (
                        <p className={`text-xs font-medium mt-0.5 ${b.stockQuantity === 0 ? 'text-red-600 dark:text-red-400' : b.stockQuantity <= 3 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                          {b.stockQuantity === 0 ? '⚠ Out of stock' : b.stockQuantity <= 3 ? `⚠ Only ${b.stockQuantity} left` : `✓ ${b.stockQuantity} in stock`}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {orderItems.length > 0 && (
              <div className="space-y-2">
                {orderItems.map(item => (
                  <div key={item.bookId} className="flex items-center gap-3 p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{item.bookTitle}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{currency} {item.unitPrice.toFixed(2)} each</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setOrderItems(items => items.map(i => i.bookId === item.bookId ? { ...i, quantity: Math.max(1, i.quantity - 1) } : i))} className="w-6 h-6 rounded bg-gray-200 dark:bg-gray-700 text-sm font-bold">-</button>
                      <span className="w-8 text-center text-sm">{item.quantity}</span>
                      <button
                        onClick={() => {
                          if (item.availableStock != null && item.quantity >= item.availableStock) {
                            showToast(`Only ${item.availableStock} in stock for "${item.bookTitle}"`, 'error');
                            return;
                          }
                          setOrderItems(items => items.map(i => i.bookId === item.bookId ? { ...i, quantity: i.quantity + 1 } : i));
                        }}
                        disabled={item.availableStock != null && item.quantity >= item.availableStock}
                        className="w-6 h-6 rounded bg-gray-200 dark:bg-gray-700 text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                      >+</button>
                      {item.availableStock != null && (
                        <span className="text-[10px] text-gray-400 ml-1">/{item.availableStock} avail</span>
                      )}
                    </div>
                    {/* Discount controls */}
                    <div className="flex items-center gap-1">
                      <select value={item.discountType} onChange={e => setOrderItems(items => items.map(i => i.bookId === item.bookId ? { ...i, discountType: e.target.value } : i))}
                        className="text-xs px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                        {['Normal','Merchant','Special'].map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <button onClick={() => setOrderItems(items => items.map(i => i.bookId === item.bookId ? { ...i, discountMode: i.discountMode === 'Percentage' ? 'Amount' : 'Percentage', discountPct: 0 } : i))}
                        className="text-xs px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 font-mono">
                        {item.discountMode === 'Percentage' ? '%' : '$'}
                      </button>
                      <input type="number" min="0" step="0.01" value={item.discountPct}
                        onChange={e => setOrderItems(items => items.map(i => i.bookId === item.bookId ? { ...i, discountPct: Math.max(0, parseFloat(e.target.value) || 0) } : i))}
                        className="w-14 text-xs px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300" />
                    </div>
                    <span className="text-sm font-medium text-gray-900 dark:text-white w-20 text-right">
                      {currency} {Math.max(0, item.discountMode === 'Percentage'
                        ? item.unitPrice * item.quantity * (1 - item.discountPct / 100)
                        : item.unitPrice * item.quantity - item.discountPct).toFixed(2)}
                    </span>
                    <button onClick={() => setOrderItems(items => items.filter(i => i.bookId !== item.bookId))} className="text-gray-400 hover:text-red-500 text-sm">×</button>
                  </div>
                ))}
                <div className="flex justify-between text-sm font-semibold text-gray-900 dark:text-white pt-2 border-t border-gray-200 dark:border-gray-700">
                  <span>Subtotal</span><span>{currency} {subtotal.toFixed(2)}</span>
                </div>
              </div>
            )}
          </div>

          <button onClick={submitOrder} disabled={createMut.isPending || orderItems.length === 0}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm">
            {createMut.isPending ? 'Creating...' : 'Create Order'}
          </button>
        </div>
      )}
    </div>
  );
}

function OrderDetailLoader({ orderId }: { orderId: string }) {
  const currency = useCurrency();
  const { data } = useQuery<{ status?: string; lineItems?: OrderLine[]; paymentMethod?: string | null; dueDate?: string | null; saleType?: 'cash_sale' | 'credit_sale' }>({
    queryKey: ['order-detail', orderId],
    queryFn: () => api.get(`/orders/${orderId}`),
  });
  if (!data?.lineItems) return <p className="text-xs text-gray-400">Loading...</p>;

  const status = data.status ?? '';
  const normalStatus = (['DRAFT','Pending'].includes(status)) ? 'DRAFT'
    : (['CONFIRMED','PAID','Confirmed','In_Progress'].includes(status)) ? 'CONFIRMED'
    : (['FULFILLED','COMPLETED','Fulfilled'].includes(status)) ? 'FULFILLED'
    : (['CANCELLED','Cancelled'].includes(status)) ? 'CANCELLED'
    : status;

  return (
    <>
      {(data.paymentMethod || data.dueDate) && (
        <div className="flex gap-4 mb-2 text-xs text-gray-600 dark:text-gray-400">
          {data.paymentMethod && (
            <span>💳 Payment method: <span className="font-medium text-gray-900 dark:text-white">{CASH_PAYMENT_METHOD_LABELS[data.paymentMethod] ?? data.paymentMethod}</span></span>
          )}
          {data.dueDate && (
            <span>📅 Due date: <span className="font-medium text-gray-900 dark:text-white">{data.dueDate}</span></span>
          )}
        </div>
      )}
      <table className="text-xs w-full max-w-2xl">
      <thead>
        <tr className="text-gray-500 dark:text-gray-400">
          {['Book', 'Ordered', 'Reserved', 'Fulfilled', 'Stock State', 'Price'].map(h => (
            <th key={h} className="text-left pr-4 pb-1">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.lineItems.map((li, i) => {
          // Derive the effective reservation/fulfillment state from order status
          // rather than relying solely on line-item fields (which may lag in display)
          let reservedDisplay: number;
          let fulfilledDisplay: number;
          let stockStateLabel: React.ReactNode;

          if (normalStatus === 'DRAFT') {
            // DRAFT: no stock impact — reservation not yet created
            reservedDisplay = 0;
            fulfilledDisplay = 0;
            stockStateLabel = <span className="text-gray-400 italic">Pending confirmation</span>;
          } else if (normalStatus === 'CONFIRMED') {
            // CONFIRMED: stock deducted, reservation active
            reservedDisplay = li.qtyReserved > 0 ? li.qtyReserved : li.quantity;
            fulfilledDisplay = li.qtyFulfilled;
            stockStateLabel = <span className="text-blue-600 dark:text-blue-400 font-medium">🔒 Stock reserved</span>;
          } else if (normalStatus === 'FULFILLED') {
            // FULFILLED: reservation released (status='deducted'), qty_fulfilled set
            reservedDisplay = 0;
            fulfilledDisplay = li.qtyFulfilled > 0 ? li.qtyFulfilled : li.quantity;
            stockStateLabel = <span className="text-green-600 dark:text-green-400 font-medium">✓ Fulfilled</span>;
          } else if (normalStatus === 'CANCELLED') {
            // CANCELLED: reservation released, stock restored
            reservedDisplay = 0;
            fulfilledDisplay = 0;
            stockStateLabel = <span className="text-red-500 dark:text-red-400 italic">Stock restored</span>;
          } else {
            reservedDisplay = li.qtyReserved;
            fulfilledDisplay = li.qtyFulfilled;
            stockStateLabel = <span className="text-gray-400">—</span>;
          }

          return (
            <tr key={i} className="border-t border-gray-100 dark:border-gray-700">
              <td className="pr-4 py-1.5 text-gray-900 dark:text-white">{li.bookTitle}</td>
              <td className="pr-4 text-gray-600 dark:text-gray-400">{li.quantity}</td>
              <td className={`pr-4 font-medium ${reservedDisplay > 0 ? 'text-orange-500 dark:text-orange-400' : 'text-gray-400'}`}>
                {reservedDisplay}
              </td>
              <td className={`pr-4 font-medium ${fulfilledDisplay > 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`}>
                {fulfilledDisplay}
              </td>
              <td className="pr-4">{stockStateLabel}</td>
              <td className="text-gray-900 dark:text-white">{currency} {Number(li.totalPrice).toFixed(2)}</td>
            </tr>
          );
        })}
      </tbody>
      </table>
    </>
  );
}
