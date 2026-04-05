import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getCurrentBranchId } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

type Role = string;
interface BookResult { id: number; title: string; isbn: string; defaultPrice: number | null; branchPrice: number | null; }
interface CartItem { bookId: number; bookTitle: string; bookIsbn: string; quantity: number; unitPrice: number; discountPct: number; discountAmount: number; lineTotal: number; }
interface Customer { id: number; customerCode: string; fullName: string; loyaltyBalance: number; storeCreditBalance: number; }
interface Location { id: number; name: string; isDefaultFulfillment: boolean; }
interface BankAccount { id: number; accountName: string; bankName: string; maskedAccountNumber: string; currency: string; }
interface TransactionLine { bookTitle: string; quantity: number; unitPrice: number; discountAmount: number; lineTotal: number; }
interface TransactionPayment { method: string; amount: number; }
interface Transaction {
  id: string; transactionNumber: string;
  subtotal: number; discountTotal: number; taxTotal: number; grandTotal: number;
  amountPaid: number; amountDue: number;
  paymentStatus: 'paid' | 'partial' | 'credit';
  currency: string; status: string; createdAt: string;
  lineItems?: TransactionLine[]; payments?: TransactionPayment[];
}
interface TxListResponse { items: Transaction[]; total: number; page: number; totalPages: number; }
interface POSPageProps { userRole?: Role; }

const canCreate = (r?: Role) => ['Sales', 'Manager'].includes(r ?? '');
const canVoid   = (r?: Role) => ['Manager', 'Admin'].includes(r ?? '');

type PaymentMethod = 'cash' | 'bank' | 'store_credit' | 'loyalty_points';
const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash', bank: 'Bank', store_credit: 'Store Credit', loyalty_points: 'Loyalty',
};

function calcCart(items: CartItem[]) {
  const subtotal     = items.reduce((s, i) => s + i.lineTotal, 0);
  const discountTotal = items.reduce((s, i) => s + i.discountAmount, 0);
  const taxTotal     = parseFloat((subtotal * 0.10).toFixed(2));
  const grandTotal   = parseFloat((subtotal + taxTotal).toFixed(2));
  return { subtotal, discountTotal, taxTotal, grandTotal };
}

type Tab = 'pos' | 'history';

export default function POSPage({ userRole }: POSPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('pos');

  const [bookSearch, setBookSearch]           = useState('');
  const [cart, setCart]                       = useState<CartItem[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch]   = useState('');
  const [locationId, setLocationId]           = useState<number | null>(null);
  const [paymentLines, setPaymentLines]       = useState<Array<{ method: PaymentMethod; amount: string; bankAccountId?: number }>>([]);
  const [payMethod, setPayMethod]             = useState<PaymentMethod>('cash');
  const [payAmount, setPayAmount]             = useState('');
  const [payBankAccountId, setPayBankAccountId] = useState<number | ''>('');
  const [receipt, setReceipt]                 = useState<Transaction | null>(null);
  const [histPage, setHistPage]               = useState(1);

  const branchId = getCurrentBranchId() ?? 1;

  // ── Queries ───────────────────────────────────────────────────────────────────

  const { data: locData } = useQuery<{ items: Location[] }>({
    queryKey: ['pos-locations', branchId],
    queryFn: () => api.get(`/branches/${branchId}/locations?pageSize=50`),
  });

  const { data: bankData } = useQuery<{ items: BankAccount[] }>({
    queryKey: ['pos-bank-accounts', branchId],
    queryFn: () => api.get(`/branches/${branchId}/bank-accounts?isActive=true&pageSize=50`),
    enabled: payMethod === 'bank',
  });

  const { data: bookResults } = useQuery<{ items: BookResult[] }>({
    queryKey: ['pos-books', bookSearch],
    queryFn: () => api.get(`/books?q=${encodeURIComponent(bookSearch)}&pageSize=10&branchId=${branchId}`),
    enabled: bookSearch.length > 1,
  });

  const { data: customerResults } = useQuery<{ items: Customer[] }>({
    queryKey: ['pos-customers', customerSearch],
    queryFn: () => api.get(`/customers?q=${encodeURIComponent(customerSearch)}&pageSize=5`),
    enabled: customerSearch.length > 1,
  });

  const { data: histData, isLoading: histLoading } = useQuery<TxListResponse>({
    queryKey: ['pos-history', histPage],
    queryFn: () => api.get(`/pos/transactions?branchId=${branchId}&page=${histPage}&pageSize=20`),
    enabled: tab === 'history',
  });

  // ── Auto-select default location ──────────────────────────────────────────────
  const locations = locData?.items ?? [];
  useEffect(() => {
    if (locations.length > 0 && locationId === null) {
      const def = locations.find(l => l.isDefaultFulfillment) ?? locations[0];
      setLocationId(def.id);
    }
  }, [locations, locationId]);

  // ── Derived totals ────────────────────────────────────────────────────────────
  const { subtotal, discountTotal, taxTotal, grandTotal } = calcCart(cart);
  const paidTotal = parseFloat(paymentLines.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0).toFixed(2));
  const remaining = parseFloat((grandTotal - paidTotal).toFixed(2));

  // ── Mutations ─────────────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<Transaction>('/pos/transactions', body),
    onSuccess: (tx) => { setReceipt(tx); showToast(`Sale ${tx.transactionNumber} completed`, 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const collectMut = useMutation({
    mutationFn: ({ txId, pmts }: { txId: string; pmts: Array<{ method: string; amount: number }> }) =>
      api.post<Transaction>(`/pos/transactions/${txId}/payment`, { payments: pmts }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pos-history'] }); showToast('Payment recorded', 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const voidMut = useMutation({
    mutationFn: (id: string) => api.post<Transaction>(`/pos/transactions/${id}/void`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pos-history'] }); showToast('Transaction voided', 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // ── Cart helpers ──────────────────────────────────────────────────────────────
  function recalcItem(item: CartItem): CartItem {
    const discountAmount = parseFloat((item.unitPrice * item.quantity * (item.discountPct / 100)).toFixed(2));
    const lineTotal      = parseFloat((item.unitPrice * item.quantity - discountAmount).toFixed(2));
    return { ...item, discountAmount, lineTotal };
  }

  function addToCart(book: BookResult) {
    const price    = book.branchPrice ?? book.defaultPrice ?? 0;
    const existing = cart.find(i => i.bookId === book.id);
    if (existing) {
      setCart(c => c.map(i => i.bookId === book.id ? recalcItem({ ...i, quantity: i.quantity + 1 }) : i));
    } else {
      setCart(c => [...c, recalcItem({ bookId: book.id, bookTitle: book.title, bookIsbn: book.isbn, quantity: 1, unitPrice: price, discountPct: 0, discountAmount: 0, lineTotal: price })]);
    }
    setBookSearch('');
  }

  function updateQty(bookId: number, delta: number) {
    setCart(c => c.map(i => i.bookId === bookId ? recalcItem({ ...i, quantity: Math.max(1, i.quantity + delta) }) : i));
  }

  function updateDiscount(bookId: number, pct: number) {
    setCart(c => c.map(i => i.bookId === bookId ? recalcItem({ ...i, discountPct: Math.max(0, Math.min(100, pct)) }) : i));
  }

  function removeFromCart(bookId: number) { setCart(c => c.filter(i => i.bookId !== bookId)); }

  // ── Payment helpers ───────────────────────────────────────────────────────────
  function addPayment() {
    const raw = payAmount.trim() !== '' ? payAmount : remaining.toFixed(2);
    const amt = parseFloat(raw);
    if (!amt || amt <= 0) return;
    if (payMethod === 'bank' && !payBankAccountId) { showToast('Select a bank account', 'error'); return; }
    setPaymentLines(prev => [...prev, { method: payMethod, amount: raw, bankAccountId: payMethod === 'bank' ? Number(payBankAccountId) : undefined }]);
    setPayAmount('');
  }

  function removePayment(idx: number) { setPaymentLines(prev => prev.filter((_, i) => i !== idx)); }

  function buildPaymentPayload() {
    return paymentLines.map(p => ({ method: p.method, amount: parseFloat(p.amount), reference: p.bankAccountId ? String(p.bankAccountId) : undefined }));
  }

  function completeSale() {
    if (!locationId) { showToast('Select a location', 'error'); return; }
    if (cart.length === 0) { showToast('Cart is empty', 'error'); return; }
    if (Math.abs(remaining) > 0.01) { showToast(`Remaining balance: ETB ${remaining.toFixed(2)}`, 'error'); return; }
    createMut.mutate({ branchId, locationId, customerId: selectedCustomer?.id ?? null, items: cart.map(i => ({ bookId: i.bookId, quantity: i.quantity, discountPct: i.discountPct })), payments: buildPaymentPayload(), allowCredit: false });
  }

  function completeCreditSale() {
    if (!locationId) { showToast('Select a location', 'error'); return; }
    if (cart.length === 0) { showToast('Cart is empty', 'error'); return; }
    if (!selectedCustomer) { showToast('Credit sales require a customer', 'error'); return; }
    createMut.mutate({ branchId, locationId, customerId: selectedCustomer.id, items: cart.map(i => ({ bookId: i.bookId, quantity: i.quantity, discountPct: i.discountPct })), payments: buildPaymentPayload(), allowCredit: true });
  }

  function newSale() { setCart([]); setPaymentLines([]); setSelectedCustomer(null); setReceipt(null); setPayAmount(''); }

  const bankAccounts = bankData?.items ?? [];

  // ── Receipt view ──────────────────────────────────────────────────────────────
  if (receipt) {
    return (
      <div className="p-6 max-w-lg mx-auto space-y-4">
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 space-y-4">
          <div className="text-center">
            <div className="text-2xl mb-1">{receipt.paymentStatus === 'paid' ? '✅' : '🟡'}</div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white">{receipt.transactionNumber}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{new Date(receipt.createdAt).toLocaleString()}</p>
            {receipt.paymentStatus !== 'paid' && (
              <span className="inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                {receipt.paymentStatus === 'partial' ? `Partial — ETB ${Number(receipt.amountDue).toFixed(2)} due` : `Credit — ETB ${Number(receipt.amountDue).toFixed(2)} due`}
              </span>
            )}
          </div>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-200 dark:border-gray-700">{['Item','Qty','Price','Total'].map(h => <th key={h} className="py-1 text-left text-xs text-gray-500 dark:text-gray-400">{h}</th>)}</tr></thead>
            <tbody>{(receipt.lineItems ?? []).map((li, i) => <tr key={i} className="border-b border-gray-100 dark:border-gray-800"><td className="py-1 text-gray-900 dark:text-white text-xs">{li.bookTitle}</td><td className="py-1 text-gray-600 dark:text-gray-400 text-xs">{li.quantity}</td><td className="py-1 text-gray-600 dark:text-gray-400 text-xs">{Number(li.unitPrice).toFixed(2)}</td><td className="py-1 text-gray-900 dark:text-white text-xs font-medium">{Number(li.lineTotal).toFixed(2)}</td></tr>)}</tbody>
          </table>
          <div className="space-y-1 text-sm border-t border-gray-200 dark:border-gray-700 pt-3">
            <div className="flex justify-between text-gray-600 dark:text-gray-400"><span>Subtotal</span><span>ETB {Number(receipt.subtotal).toFixed(2)}</span></div>
            {Number(receipt.discountTotal) > 0 && <div className="flex justify-between text-green-600 dark:text-green-400"><span>Discount</span><span>-ETB {Number(receipt.discountTotal).toFixed(2)}</span></div>}
            <div className="flex justify-between text-gray-600 dark:text-gray-400"><span>Tax (10%)</span><span>ETB {Number(receipt.taxTotal).toFixed(2)}</span></div>
            <div className="flex justify-between font-bold text-gray-900 dark:text-white text-base border-t border-gray-200 dark:border-gray-700 pt-1"><span>Total</span><span>ETB {Number(receipt.grandTotal).toFixed(2)}</span></div>
          </div>
          <div className="space-y-1 text-sm">{(receipt.payments ?? []).map((p, i) => <div key={i} className="flex justify-between text-gray-600 dark:text-gray-400"><span className="capitalize">{p.method.replace(/_/g, ' ')}</span><span>ETB {Number(p.amount).toFixed(2)}</span></div>)}</div>
          <div className="flex gap-3 pt-2">
            <button onClick={() => window.print()} className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Print</button>
            <button onClick={newSale} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 rounded-lg transition-colors">New Sale</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main layout ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex-shrink-0">
        {(['pos', 'history'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${tab === t ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {t === 'pos' ? '🛒 POS Terminal' : '📋 History'}
          </button>
        ))}
      </div>

      {/* ── History tab ── */}
      {tab === 'history' && (
        <div className="flex-1 overflow-auto p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
            {histLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : (
              <table className="w-full text-sm min-w-[800px]">
                <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <tr>{['Tx #', 'Total', 'Paid', 'Due', 'Status', 'Payment', 'Date', 'Actions'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {(histData?.items ?? []).map(tx => (
                    <tr key={tx.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">{tx.transactionNumber}</td>
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">ETB {Number(tx.grandTotal).toFixed(2)}</td>
                      <td className="px-4 py-3 text-sm text-green-700 dark:text-green-400 whitespace-nowrap">ETB {Number(tx.amountPaid ?? tx.grandTotal).toFixed(2)}</td>
                      <td className="px-4 py-3 text-sm text-amber-700 dark:text-amber-400 whitespace-nowrap">{Number(tx.amountDue ?? 0) > 0 ? `ETB ${Number(tx.amountDue).toFixed(2)}` : '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${tx.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>{tx.status}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${tx.paymentStatus === 'paid' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : tx.paymentStatus === 'partial' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>{tx.paymentStatus ?? 'paid'}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(tx.createdAt).toLocaleString()}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          {canVoid(userRole) && tx.status === 'completed' && (
                            <button onClick={() => { if (confirm('Void this transaction?')) voidMut.mutate(tx.id); }} className="text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950 px-2 py-1 rounded transition-colors whitespace-nowrap">Void</button>
                          )}
                          {tx.status === 'completed' && tx.paymentStatus !== 'paid' && (
                            <button onClick={() => {
                              const amt = prompt(`Collect payment\n${tx.transactionNumber}\nOutstanding: ETB ${Number(tx.amountDue).toFixed(2)}\n\nEnter amount:`);
                              if (!amt) return;
                              const parsed = parseFloat(amt);
                              if (!parsed || parsed <= 0) return;
                              collectMut.mutate({ txId: tx.id, pmts: [{ method: 'cash', amount: parsed }] });
                            }} className="text-xs text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950 px-2 py-1 rounded transition-colors font-medium whitespace-nowrap">Collect</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(!histData?.items || histData.items.length === 0) && !histLoading && (
              <p className="text-center text-gray-400 text-sm py-8">No transactions found</p>
            )}
          </div>
          {histData && histData.totalPages > 1 && (
            <div className="flex justify-between items-center mt-3 text-sm text-gray-500 dark:text-gray-400">
              <span>Page {histData.page} of {histData.totalPages}</span>
              <div className="flex gap-2">
                <button disabled={histPage <= 1} onClick={() => setHistPage(p => p - 1)} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Prev</button>
                <button disabled={histPage >= histData.totalPages} onClick={() => setHistPage(p => p + 1)} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Next</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── POS Terminal tab ── */}
      {tab === 'pos' && (
        <div className="flex flex-1 overflow-hidden">

          {/* Left: Book search + Customer */}
          <div className="w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
            <div className="p-3 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-2">Search Books</p>
              <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="Title or ISBN..." autoFocus
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="flex-1 overflow-y-auto">
              {(bookResults?.items ?? []).map(b => (
                <button key={b.id} onClick={() => addToCart(b)} className="w-full text-left px-3 py-2.5 border-b border-gray-100 dark:border-gray-800 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{b.title}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{b.isbn} · ETB {(b.branchPrice ?? b.defaultPrice ?? 0).toFixed(2)}</p>
                </button>
              ))}
              {bookSearch.length > 1 && (bookResults?.items ?? []).length === 0 && (
                <p className="p-4 text-sm text-gray-400 text-center">No books found</p>
              )}
            </div>
            {/* Customer */}
            <div className="p-3 border-t border-gray-200 dark:border-gray-800 flex-shrink-0">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-2">Customer</p>
              {selectedCustomer ? (
                <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-950/30 rounded-lg px-3 py-2">
                  <div>
                    <p className="text-xs font-medium text-gray-900 dark:text-white">{selectedCustomer.fullName}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Pts: {selectedCustomer.loyaltyBalance} · Credit: ETB {Number(selectedCustomer.storeCreditBalance).toFixed(2)}</p>
                  </div>
                  <button onClick={() => setSelectedCustomer(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm">×</button>
                </div>
              ) : (
                <div className="relative">
                  <input value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} placeholder="Search customer..."
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  {(customerResults?.items ?? []).length > 0 && (
                    <div className="absolute bottom-full left-0 right-0 mb-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10">
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
          </div>

          {/* Center: Cart */}
          <div className="flex-1 flex flex-col overflow-hidden bg-gray-50 dark:bg-gray-950">
            <div className="p-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex items-center justify-between flex-shrink-0">
              <p className="text-sm font-semibold text-gray-900 dark:text-white">Cart ({cart.length} items)</p>
              {cart.length > 0 && <button onClick={() => setCart([])} className="text-xs text-red-500 hover:text-red-700 transition-colors">Clear All</button>}
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {cart.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-400">
                  <span className="text-4xl mb-2">🛒</span>
                  <p className="text-sm">Search for books to add</p>
                </div>
              ) : cart.map(item => (
                <div key={item.bookId} className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{item.bookTitle}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{item.bookIsbn} · ETB {item.unitPrice.toFixed(2)} each</p>
                    </div>
                    <button onClick={() => removeFromCart(item.bookId)} className="text-gray-400 hover:text-red-500 transition-colors text-sm flex-shrink-0">×</button>
                  </div>
                  <div className="flex items-center gap-3 mt-2">
                    <div className="flex items-center gap-1">
                      <button onClick={() => updateQty(item.bookId, -1)} className="w-6 h-6 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 text-sm font-bold transition-colors">-</button>
                      <span className="w-8 text-center text-sm font-medium text-gray-900 dark:text-white">{item.quantity}</span>
                      <button onClick={() => updateQty(item.bookId, 1)} className="w-6 h-6 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 text-sm font-bold transition-colors">+</button>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                      <span>Disc%:</span>
                      <input type="number" min="0" max="100" value={item.discountPct} onChange={e => updateDiscount(item.bookId, Number(e.target.value))}
                        className="w-14 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    </div>
                    <div className="ml-auto text-sm font-semibold text-gray-900 dark:text-white">ETB {item.lineTotal.toFixed(2)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Summary + Payment */}
          <div className="w-80 flex-shrink-0 border-l border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
            {/* Location */}
            <div className="p-3 border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Location</label>
              <select value={locationId ?? ''} onChange={e => setLocationId(Number(e.target.value) || null)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Select location...</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
              </select>
            </div>
            {/* Totals */}
            <div className="p-3 border-b border-gray-200 dark:border-gray-800 space-y-1 text-sm flex-shrink-0">
              <div className="flex justify-between text-gray-600 dark:text-gray-400"><span>Subtotal</span><span>ETB {subtotal.toFixed(2)}</span></div>
              {discountTotal > 0 && <div className="flex justify-between text-green-600 dark:text-green-400"><span>Discount</span><span>-ETB {discountTotal.toFixed(2)}</span></div>}
              <div className="flex justify-between text-gray-600 dark:text-gray-400"><span>Tax (10%)</span><span>ETB {taxTotal.toFixed(2)}</span></div>
              <div className="flex justify-between font-bold text-gray-900 dark:text-white text-base border-t border-gray-200 dark:border-gray-700 pt-1"><span>Total</span><span>ETB {grandTotal.toFixed(2)}</span></div>
            </div>
            {/* Payment */}
            <div className="p-3 border-b border-gray-200 dark:border-gray-800 flex-1 overflow-y-auto space-y-2">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Payment</p>
              <div className="grid grid-cols-4 gap-1">
                {(['cash', 'bank', 'store_credit', 'loyalty_points'] as PaymentMethod[]).map(m => (
                  <button key={m} onClick={() => setPayMethod(m)}
                    className={`text-xs py-1.5 rounded transition-colors ${payMethod === m ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                    {METHOD_LABELS[m]}
                  </button>
                ))}
              </div>
              {payMethod === 'bank' && (
                <select value={payBankAccountId} onChange={e => setPayBankAccountId(Number(e.target.value) || '')}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Select bank account...</option>
                  {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.bankName} — {b.accountName} ({b.maskedAccountNumber})</option>)}
                </select>
              )}
              {remaining > 0.01 && (
                <button onClick={() => setPayAmount(remaining.toFixed(2))}
                  className="w-full text-xs py-1.5 rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors font-medium">
                  ↙ Fill ETB {remaining.toFixed(2)}
                </button>
              )}
              <div className="flex gap-2">
                <input type="number" min="0" step="0.01" value={payAmount}
                  onChange={e => setPayAmount(e.target.value)}
                  placeholder={`ETB ${remaining > 0 ? remaining.toFixed(2) : '0.00'}`}
                  onKeyDown={e => e.key === 'Enter' && addPayment()}
                  className="flex-1 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <button onClick={addPayment} className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Add</button>
              </div>
              {paymentLines.map((p, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400 capitalize">{p.method.replace(/_/g, ' ')}</span>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-white">ETB {parseFloat(p.amount).toFixed(2)}</span>
                    <button onClick={() => removePayment(i)} className="text-gray-400 hover:text-red-500 text-xs transition-colors">×</button>
                  </div>
                </div>
              ))}
              {cart.length > 0 && (
                <div className={`flex justify-between text-sm font-semibold pt-2 border-t border-gray-200 dark:border-gray-700 ${remaining > 0.01 ? 'text-amber-600 dark:text-amber-400' : remaining < -0.01 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                  <span>{remaining > 0.01 ? 'Pending Balance' : remaining < -0.01 ? 'Overpaid' : '✓ Paid'}</span>
                  <span>ETB {Math.abs(remaining).toFixed(2)}</span>
                </div>
              )}
            </div>
            {/* Action buttons */}
            {canCreate(userRole) && (
              <div className="p-3 space-y-2 flex-shrink-0">
                <button onClick={completeSale}
                  disabled={createMut.isPending || cart.length === 0 || !locationId || Math.abs(remaining) > 0.01}
                  className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm">
                  {createMut.isPending ? 'Processing...' : `Complete Sale · ETB ${grandTotal.toFixed(2)}`}
                </button>
                {remaining > 0.01 && (
                  <button onClick={completeCreditSale}
                    disabled={createMut.isPending || cart.length === 0 || !locationId || !selectedCustomer}
                    title={!selectedCustomer ? 'Select a customer to allow credit sale' : ''}
                    className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg transition-colors text-sm">
                    {createMut.isPending ? 'Processing...' : `Credit Sale · Due ETB ${remaining.toFixed(2)}`}
                  </button>
                )}
                {!locationId && cart.length > 0 && <p className="text-xs text-amber-600 dark:text-amber-400 text-center">Select a location to continue</p>}
                {remaining > 0.01 && !selectedCustomer && cart.length > 0 && <p className="text-xs text-amber-600 dark:text-amber-400 text-center">Select a customer to enable credit sale</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
