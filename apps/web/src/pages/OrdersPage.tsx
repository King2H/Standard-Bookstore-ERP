import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

type Role = string;
interface OrdersPageProps { userRole?: Role; }

interface OrderLine { id: string; bookId: number; bookTitle: string; quantity: number; unitPrice: number; totalPrice: number; qtyReserved: number; qtyFulfilled: number; isBackordered: boolean; }
interface Order { id: string; orderNumber: string; customerId: number | null; branchId: number; channel: string; status: string; paymentStatus: string; currency: string; subtotal: number; taxAmount: number; total: number; cancelReason: string | null; createdAt: string; lineItems?: OrderLine[]; }
interface OrderListResponse { items: Order[]; total: number; page: number; totalPages: number; }
interface Customer { id: number; customerCode: string; fullName: string; }
interface BookResult { id: number; title: string; isbn: string; defaultPrice: number | null; branchPrice: number | null; stockQuantity?: number | null; }

const STATUS_COLORS: Record<string, string> = {
  Pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  Confirmed: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  In_Progress: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  Fulfilled: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  Cancelled: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
};
const PAY_COLORS: Record<string, string> = {
  unpaid: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  partial: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  paid: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  refunded: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

const canCreate  = (r?: Role) => ['Sales', 'Manager', 'Admin'].includes(r ?? '');
const canConfirm = (r?: Role) => ['Manager', 'Admin'].includes(r ?? '');
const canCancel  = (r?: Role) => ['Manager', 'Admin'].includes(r ?? '');

type Tab = 'list' | 'new';

export default function OrdersPage({ userRole }: OrdersPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('list');
  const branchId = getCurrentBranchId() ?? 1;

  // List state
  const [listPage, setListPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  // New order state
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [channel, setChannel] = useState<'in_store' | 'phone' | 'online'>('in_store');
  const [bookSearch, setBookSearch] = useState('');
  const [orderItems, setOrderItems] = useState<Array<{ bookId: number; bookTitle: string; quantity: number; unitPrice: number }>>([]);

  // Queries
  const { data: listData, isLoading } = useQuery<OrderListResponse>({
    queryKey: ['orders-list', listPage, branchId, statusFilter],
    queryFn: () => api.get(`/orders?branchId=${branchId}&page=${listPage}&pageSize=20${statusFilter ? `&status=${statusFilter}` : ''}`),
    enabled: tab === 'list',
  });

  const { data: customerResults } = useQuery<{ items: Customer[] }>({
    queryKey: ['order-customers', customerSearch],
    queryFn: () => api.get(`/customers?q=${encodeURIComponent(customerSearch)}&pageSize=5`),
    enabled: customerSearch.length > 1,
  });

  const { data: bookResults } = useQuery<{ items: BookResult[] }>({
    queryKey: ['order-books', bookSearch],
    queryFn: () => api.get(`/books?q=${encodeURIComponent(bookSearch)}&pageSize=8&branchId=${branchId}`),
    enabled: bookSearch.length > 1,
  });

  // Mutations
  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<Order>('/orders', body),
    onSuccess: (o) => { showToast(`Order ${o.orderNumber} created`, 'success'); setTab('list'); setOrderItems([]); setSelectedCustomer(null); qc.invalidateQueries({ queryKey: ['orders-list'] }); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const actionMut = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) => api.post<Order>(`/orders/${id}/${action}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['orders-list'] }); showToast('Order updated', 'success'); setCancelingId(null); setCancelReason(''); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  function addItem(book: BookResult) {
    const price = book.branchPrice ?? book.defaultPrice ?? 0;
    const existing = orderItems.find(i => i.bookId === book.id);
    if (existing) {
      setOrderItems(items => items.map(i => i.bookId === book.id ? { ...i, quantity: i.quantity + 1 } : i));
    } else {
      setOrderItems(items => [...items, { bookId: book.id, bookTitle: book.title, quantity: 1, unitPrice: price }]);
    }
    setBookSearch('');
  }

  function submitOrder() {
    if (orderItems.length === 0) { showToast('Add at least one item', 'error'); return; }
    createMut.mutate({ customerId: selectedCustomer?.id ?? null, channel, items: orderItems.map(i => ({ bookId: i.bookId, quantity: i.quantity })) });
  }

  const subtotal = orderItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex-shrink-0">
        {(['list', 'new'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-medium transition-colors ${tab === t ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {t === 'list' ? '📋 Orders' : '+ New Order'}
          </button>
        ))}
      </div>

      {/* ── Orders List ── */}
      {tab === 'list' && (
        <div className="flex-1 overflow-auto p-4 space-y-3">
          <div className="flex gap-2 items-center">
            <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setListPage(1); }}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">All statuses</option>
              {['Pending','Confirmed','In_Progress','Fulfilled','Cancelled'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
            {isLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : (
              <table className="w-full text-sm min-w-[800px]">
                <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <tr>{['Order #','Channel','Status','Payment','Total','Date','Actions'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {(listData?.items ?? []).map(order => (
                    <>
                      <tr key={order.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer" onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}>
                        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{order.orderNumber}</td>
                        <td className="px-4 py-3 text-xs capitalize text-gray-600 dark:text-gray-400">{order.channel.replace('_', ' ')}</td>
                        <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[order.status] ?? ''}`}>{order.status}</span></td>
                        <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PAY_COLORS[order.paymentStatus] ?? ''}`}>{order.paymentStatus}</span></td>
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">ETB {Number(order.total).toFixed(2)}</td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(order.createdAt).toLocaleString()}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 flex-wrap">
                            {canConfirm(userRole) && order.status === 'Pending' && <button onClick={e => { e.stopPropagation(); actionMut.mutate({ id: order.id, action: 'confirm' }); }} className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 px-2 py-0.5 rounded hover:bg-blue-200 transition-colors">Confirm</button>}
                            {canConfirm(userRole) && order.status === 'Confirmed' && <button onClick={e => { e.stopPropagation(); actionMut.mutate({ id: order.id, action: 'progress' }); }} className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 px-2 py-0.5 rounded hover:bg-purple-200 transition-colors">Progress</button>}
                            {canConfirm(userRole) && ['Confirmed','In_Progress'].includes(order.status) && <button onClick={e => { e.stopPropagation(); actionMut.mutate({ id: order.id, action: 'fulfill' }); }} className="text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 px-2 py-0.5 rounded hover:bg-green-200 transition-colors">Fulfill</button>}
                            {canCancel(userRole) && !['Fulfilled','Cancelled'].includes(order.status) && (
                              cancelingId === order.id ? (
                                <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                                  <input value={cancelReason} onChange={e => setCancelReason(e.target.value)} placeholder="Reason..." className="text-xs px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white w-28" />
                                  <button onClick={() => actionMut.mutate({ id: order.id, action: 'cancel', body: { reason: cancelReason || 'No reason' } })} className="text-xs bg-red-600 text-white px-2 py-0.5 rounded">OK</button>
                                  <button onClick={() => setCancelingId(null)} className="text-xs text-gray-500 px-1">✕</button>
                                </div>
                              ) : (
                                <button onClick={e => { e.stopPropagation(); setCancelingId(order.id); }} className="text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950 px-2 py-0.5 rounded transition-colors">Cancel</button>
                              )
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
                    </>
                  ))}
                </tbody>
              </table>
            )}
            {(!listData?.items || listData.items.length === 0) && !isLoading && <p className="text-center text-gray-400 text-sm py-8">No orders found</p>}
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

      {/* ── New Order ── */}
      {tab === 'new' && canCreate(userRole) && (
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

          {/* Items */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Items</h3>
            <div className="relative">
              <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="Search books to add..."
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              {(bookResults?.items ?? []).length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
                  {(bookResults?.items ?? []).map(b => (
                    <button key={b.id} onClick={() => addItem(b)} className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors border-b border-gray-100 dark:border-gray-800 last:border-0">
                      <p className="font-medium text-gray-900 dark:text-white truncate">{b.title}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{b.isbn} · ETB {(b.branchPrice ?? b.defaultPrice ?? 0).toFixed(2)}</p>
                      {b.stockQuantity != null && (
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
                      <p className="text-xs text-gray-500 dark:text-gray-400">ETB {item.unitPrice.toFixed(2)} each</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setOrderItems(items => items.map(i => i.bookId === item.bookId ? { ...i, quantity: Math.max(1, i.quantity - 1) } : i))} className="w-6 h-6 rounded bg-gray-200 dark:bg-gray-700 text-sm font-bold">-</button>
                      <span className="w-8 text-center text-sm">{item.quantity}</span>
                      <button onClick={() => setOrderItems(items => items.map(i => i.bookId === item.bookId ? { ...i, quantity: i.quantity + 1 } : i))} className="w-6 h-6 rounded bg-gray-200 dark:bg-gray-700 text-sm font-bold">+</button>
                    </div>
                    <span className="text-sm font-medium text-gray-900 dark:text-white w-20 text-right">ETB {(item.unitPrice * item.quantity).toFixed(2)}</span>
                    <button onClick={() => setOrderItems(items => items.filter(i => i.bookId !== item.bookId))} className="text-gray-400 hover:text-red-500 text-sm">×</button>
                  </div>
                ))}
                <div className="flex justify-between text-sm font-semibold text-gray-900 dark:text-white pt-2 border-t border-gray-200 dark:border-gray-700">
                  <span>Subtotal (excl. tax)</span><span>ETB {subtotal.toFixed(2)}</span>
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
  const { data } = useQuery<{ lineItems?: OrderLine[] }>({
    queryKey: ['order-detail', orderId],
    queryFn: () => api.get(`/orders/${orderId}`),
  });
  if (!data?.lineItems) return <p className="text-xs text-gray-400">Loading...</p>;
  return (
    <table className="text-xs w-full max-w-xl">
      <thead><tr className="text-gray-500 dark:text-gray-400">{['Book','Qty','Reserved','Fulfilled','Backordered','Price'].map(h => <th key={h} className="text-left pr-4 pb-1">{h}</th>)}</tr></thead>
      <tbody>{data.lineItems.map((li, i) => (
        <tr key={i}>
          <td className="pr-4 text-gray-900 dark:text-white">{li.bookTitle}</td>
          <td className="pr-4 text-gray-600 dark:text-gray-400">{li.quantity}</td>
          <td className="pr-4 text-blue-600 dark:text-blue-400">{li.qtyReserved}</td>
          <td className="pr-4 text-green-600 dark:text-green-400">{li.qtyFulfilled}</td>
          <td className="pr-4">{li.isBackordered ? <span className="text-amber-600 dark:text-amber-400">Yes</span> : '—'}</td>
          <td className="text-gray-900 dark:text-white">ETB {Number(li.totalPrice).toFixed(2)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}
