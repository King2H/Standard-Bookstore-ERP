import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, downloadFile, getCurrentBranchId } from '../lib/api.js';
import { paymentMethodPlainLabel } from '../lib/paymentMethods.js';
import { useToast } from '../components/Toast.js';
import BankAccountSelect from '../components/BankAccountSelect.js';
import { useBranchBankAccounts } from '../features/bankAccounts/queries.js';

// What is left of the old Procurement page until #23's PRs 2 and 3 move it to
// features/procurement: the order form, receiving, the supplier ledger, and an
// order's payments and credit notes. The page is features/procurement/pages.

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
interface Supplier { id: number; name: string; isActive: boolean; isBlacklisted: boolean; }
interface Location { id: number; name: string; branchId: number; isDefaultFulfillment: boolean; }



// ── RBAC helpers ──────────────────────────────────────────────────────────────


// What is left of the Procurement page until #23's PRs 2 and 3 move it to
// features/procurement: the order form, receiving, the supplier ledger, and
// an order's payments and credit notes. The page is features/procurement/pages.

// ── Line item form row ────────────────────────────────────────────────────────

interface LineItemFormRow { bookId: number | null; bookTitle: string; quantity: number; unitCost: number; }

const EMPTY_LINE: LineItemFormRow = { bookId: null, bookTitle: '', quantity: 1, unitCost: 0 };

// ── Book search combobox ──────────────────────────────────────────────────────

interface CatalogBook {
  id: number; title: string; isbn: string; isActive: boolean;
  availability?: { onHand: number; reserved: number; available: number } | null;
}

/** Debounce a value by `delay` ms. */
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/**
 * Per-row book search combobox.
 * - Empty / <2 chars → no API call, empty list.
 * - ≥2 chars (debounced 300 ms) → GET /catalog/search?q=<term>
 * - On selection: calls onSelect(book) and closes dropdown.
 */
function BookSearchCombobox({
  value,
  onChange,
  branchId,
  locationId,
}: {
  value: { bookId: number | null; bookTitle: string };
  onChange: (book: { bookId: number | null; bookTitle: string }) => void;
  /** Module 8: when a receiving branch/location is known, show current
   *  available stock next to each result so the buyer can see what's
   *  already on hand before deciding how much to reorder. */
  branchId?: number | null;
  locationId?: number | null;
}) {
  const [inputText, setInputText] = useState(value.bookTitle);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedQuery = useDebounce(inputText, 300);

  // Sync external value changes (e.g. when editing a PO)
  useEffect(() => {
    setInputText(value.bookTitle);
  }, [value.bookTitle]);

  const withAvailability = !!locationId;
  const { data, isFetching } = useQuery<{ results?: CatalogBook[]; items?: CatalogBook[] }>({
    queryKey: ['catalog-search-po', debouncedQuery, branchId, locationId],
    queryFn: () => withAvailability
      ? api.get(`/books/with-availability?q=${encodeURIComponent(debouncedQuery)}&pageSize=10&branchId=${branchId}&locationId=${locationId}`)
      : api.get(`/catalog/search?q=${encodeURIComponent(debouncedQuery)}`),
    enabled: debouncedQuery.trim().length >= 2,
    staleTime: 30_000,
  });

  const results = data?.results ?? data?.items ?? [];

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const text = e.target.value;
    setInputText(text);
    setOpen(true);
    // Clear the selected bookId when the user edits the text
    if (value.bookId !== null) {
      onChange({ bookId: null, bookTitle: text });
    }
  }

  function handleSelect(book: CatalogBook) {
    setInputText(book.title);
    setOpen(false);
    onChange({ bookId: book.id, bookTitle: book.title });
  }

  const showDropdown = open && debouncedQuery.trim().length >= 2;

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={inputText}
        placeholder="Type to search books…"
        autoComplete="off"
        onChange={handleInput}
        onFocus={() => { if (debouncedQuery.trim().length >= 2) setOpen(true); }}
        className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500"
      />
      {showDropdown && (
        <ul className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg text-sm">
          {isFetching && (
            <li className="px-3 py-2 text-gray-400">Searching…</li>
          )}
          {!isFetching && results.length === 0 && (
            <li className="px-3 py-2 text-gray-400">No books found</li>
          )}
          {results.filter(b => b.isActive).map(book => (
            <li
              key={book.id}
              onMouseDown={() => handleSelect(book)}
              className="px-3 py-2 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30 text-gray-900 dark:text-white"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{book.title}</span>
                {book.availability != null && (
                  <span className={`text-xs font-semibold shrink-0 px-1.5 py-0.5 rounded-full ${book.availability.available === 0 ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400' : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'}`}>
                    {book.availability.available} avail
                  </span>
                )}
              </div>
              {book.isbn && <span className="text-xs text-gray-400">{book.isbn}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── View 4: Create/Edit PO Form ───────────────────────────────────────────────

export function POForm({ editing, onSaved, onCancel }: { editing?: PO; onSaved: (po: PO) => void; onCancel: () => void }) {
  const { showToast } = useToast();
  const [supplierId, setSupplierId] = useState<number | null>(editing?.supplierId ?? null);
  // Purchase orders are in ETB: their amounts become stock costs and supplier balances.
  const currency = 'ETB';
  const [paymentTerms, setPaymentTerms] = useState<'cash' | 'credit'>(editing?.paymentTerms ?? 'credit');
  const [expectedDate, setExpectedDate] = useState(editing?.expectedDeliveryDate ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [receivingBranchId, setReceivingBranchId] = useState<number | null>(editing?.receivingBranchId ?? null);
  const [receivingLocationId, setReceivingLocationId] = useState<number | null>(editing?.receivingLocationId ?? null);
  const [lineItems, setLineItems] = useState<LineItemFormRow[]>(
    editing?.lineItems?.map(li => ({ bookId: li.bookId, bookTitle: li.bookTitle, quantity: li.quantity, unitCost: li.unitCost })) ?? [{ ...EMPTY_LINE }],
  );

  const { data: suppliersData } = useQuery<{ items: Supplier[] }>({
    queryKey: ['suppliers-for-po'],
    queryFn: () => api.get('/suppliers?isActive=true&isBlacklisted=false&pageSize=200'),
  });

  const { data: branchesData } = useQuery<{ items: Array<{id: number; name: string}> }>({
    queryKey: ['branches-for-po'],
    queryFn: () => api.get('/branches?pageSize=200'),
  });

  const { data: receivingLocData } = useQuery<{ items: Array<{id: number; name: string; isDefaultFulfillment: boolean}> }>({
    queryKey: ['receiving-locations', receivingBranchId],
    queryFn: () => api.get(`/branches/${receivingBranchId}/locations?pageSize=200`),
    enabled: !!receivingBranchId,
  });

  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<PO>('/purchase-orders', body),
    onSuccess: (po) => { showToast('PO created', 'success'); onSaved(po); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
  const updateMut = useMutation({
    mutationFn: (body: unknown) => api.put<PO>(`/purchase-orders/${editing!.id}`, body),
    onSuccess: (po) => { showToast('PO updated', 'success'); onSaved(po); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const suppliers = suppliersData?.items ?? [];
  const branches = branchesData?.items ?? [];
  const receivingLocations = receivingLocData?.items ?? [];
  const total = lineItems.reduce((s, li) => s + li.quantity * li.unitCost, 0);
  const busy = createMut.isPending || updateMut.isPending;

  function addLine() { setLineItems(l => [...l, { ...EMPTY_LINE }]); }
  function removeLine(i: number) { setLineItems(l => l.filter((_, idx) => idx !== i)); }
  function updateLine(i: number, field: keyof LineItemFormRow, value: unknown) {
    setLineItems(l => l.map((li, idx) => idx === i ? { ...li, [field]: value } : li));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!supplierId) { showToast('Please select a supplier', 'error'); return; }
    const validLines = lineItems.filter(li => li.bookId);
    if (!validLines.length) { showToast('At least one line item with a book is required', 'error'); return; }
    const body = {
      supplierId,
      paymentTerms,
      expectedDeliveryDate: expectedDate || null,
      notes: notes || null,
      receivingBranchId: receivingBranchId || null,
      receivingLocationId: receivingLocationId || null,
      lineItems: validLines.map(li => ({ bookId: li.bookId, quantity: li.quantity, unitCost: li.unitCost })),
    };
    if (editing) updateMut.mutate(body); else createMut.mutate(body);
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6 pb-8">
      <div className="flex items-center gap-3">
        <button onClick={onCancel} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back</button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{editing ? 'Edit Purchase Order' : 'New Purchase Order'}</h2>
      </div>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Order Details</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Supplier *</label>
              <select required value={supplierId ?? ''} onChange={e => setSupplierId(Number(e.target.value) || null)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
                <option value="">Select supplier...</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Currency</label>
              <p className="px-3 py-2 text-sm text-gray-900 dark:text-white">{currency}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Payment Terms</label>
              <select value={paymentTerms} onChange={e => setPaymentTerms(e.target.value as 'cash' | 'credit')}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
                <option value="credit">Credit (pay later)</option>
                <option value="cash">Cash (settles on receipt)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Expected Delivery</label>
              <input type="date" value={expectedDate} onChange={e => setExpectedDate(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
              <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Receiving Branch</label>
              <select value={receivingBranchId ?? ''} onChange={e => { setReceivingBranchId(Number(e.target.value) || null); setReceivingLocationId(null); }}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
                <option value="">Same as order branch (default)</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            {receivingBranchId && (
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Receiving Location</label>
                <select value={receivingLocationId ?? ''} onChange={e => setReceivingLocationId(Number(e.target.value) || null)}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
                  <option value="">Default fulfillment location</option>
                  {receivingLocations.map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Line Items</h3>
            <button type="button" onClick={addLine} className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 font-medium">+ Add Item</button>
          </div>
          {lineItems.map((li, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-5">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Book</label>
                <BookSearchCombobox
                  value={{ bookId: li.bookId, bookTitle: li.bookTitle }}
                  onChange={({ bookId, bookTitle }) => {
                    updateLine(i, 'bookId', bookId);
                    updateLine(i, 'bookTitle', bookTitle);
                  }}
                  branchId={receivingBranchId ?? getCurrentBranchId()}
                  locationId={receivingLocationId}
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Qty</label>
                <input type="number" min={1} value={li.quantity} onChange={e => updateLine(i, 'quantity', Math.max(1, Number(e.target.value)))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="col-span-3">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Unit Cost</label>
                <input type="number" min={0} step="0.01" value={li.unitCost} onChange={e => updateLine(i, 'unitCost', Math.max(0, Number(e.target.value)))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="col-span-1 text-right text-xs text-gray-500 dark:text-gray-400 pb-2">
                {(li.quantity * li.unitCost).toFixed(2)}
              </div>
              <div className="col-span-1 pb-1">
                {lineItems.length > 1 && <button type="button" onClick={() => removeLine(i)} className="text-red-500 hover:text-red-700 text-sm">✕</button>}
              </div>
            </div>
          ))}
          <div className="flex justify-end pt-2 border-t border-gray-100 dark:border-gray-800">
            <span className="text-sm font-semibold text-gray-900 dark:text-white">Total: {currency} {total.toFixed(2)}</span>
          </div>
        </div>

        <div className="flex gap-3">
          <button type="button" onClick={onCancel} className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Cancel</button>
          <button type="submit" disabled={busy} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">{busy ? 'Saving...' : 'Save as Draft'}</button>
        </div>
      </form>
    </div>
  );
}

// ── View 3: Receive Goods (GRN form) ─────────────────────────────────────────

export function ReceiveForm({ po: poProp, onDone, onBack }: { po: PO; onDone: (updated: PO) => void; onBack: () => void }) {
  const { showToast } = useToast();
  const [locationId, setLocationId] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  // Always fetch the full PO detail to ensure lineItems are loaded
  const { data: po, isLoading: poLoading } = useQuery<PO>({
    queryKey: ['po-detail-receive', poProp.id],
    queryFn: () => api.get(`/purchase-orders/${poProp.id}`),
    staleTime: 0,
  });

  // Use PO's receiving branch for location query
  const effectiveBranchId = (po ?? poProp).receivingBranchId ?? (po ?? poProp).branchId;

  const { data: locData } = useQuery<{ items: Location[] }>({
    queryKey: ['locations-for-receive', effectiveBranchId],
    queryFn: () => api.get(`/branches/${effectiveBranchId}/locations?pageSize=200`),
    enabled: !!effectiveBranchId,
  });

  // Auto-select PO's receiving location or default fulfillment location
  const locations = locData?.items ?? [];
  if (!locationId && locations.length > 0) {
    const preferred = locations.find(l => l.id === (po ?? poProp).receivingLocationId)
      ?? locations.find(l => l.isDefaultFulfillment)
      ?? locations[0];
    setLocationId(preferred.id);
  }

  const receiveMut = useMutation({
    mutationFn: (body: unknown) => api.post<PO>(`/purchase-orders/${poProp.id}/receive`, body),
    onSuccess: (updated) => {
      showToast('Goods received', 'success');
      onDone(updated);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const receivableLines = (po?.lineItems ?? []).filter(li => li.remaining > 0);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!locationId) { showToast('Please select a location', 'error'); return; }
    const items = receivableLines
      .filter(li => (quantities[li.id] ?? 0) > 0)
      .map(li => ({ poLineItemId: Number(li.id), quantityReceived: quantities[li.id] }));
    if (!items.length) { showToast('Enter quantity for at least one item', 'error'); return; }
    receiveMut.mutate({ locationId, items, notes: notes || null });
  }

  if (poLoading) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back to PO</button>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Receive Goods — PO #{poProp.id}</h2>
        </div>
        <div className="p-8 text-center text-gray-400">Loading PO details...</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-5 pb-8">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back to PO</button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Receive Goods — PO #{poProp.id}</h2>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Destination Location *</label>
            <select required value={locationId ?? ''} onChange={e => setLocationId(Number(e.target.value) || null)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500">
              <option value="">Select location...</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
            <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>{['Book', 'Ordered', 'Received', 'Remaining', 'Qty to Receive'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {receivableLines.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">
                    All items have been fully received.
                  </td>
                </tr>
              ) : receivableLines.map(li => (
                <tr key={li.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-3 text-gray-900 dark:text-white">{li.bookTitle}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.quantity}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.receivedQuantity}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.remaining}</td>
                  <td className="px-4 py-3">
                    <input type="number" min={0} max={li.remaining} value={quantities[li.id] ?? 0}
                      onChange={e => setQuantities(q => ({ ...q, [li.id]: Math.min(li.remaining, Math.max(0, Number(e.target.value))) }))}
                      className="w-20 border border-gray-300 dark:border-gray-600 rounded-sm px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex gap-3">
          <button type="button" onClick={onBack} className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Back</button>
          <button type="submit" disabled={receiveMut.isPending} className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">{receiveMut.isPending ? 'Submitting...' : 'Submit Receipt'}</button>
        </div>
      </form>
    </div>
  );
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

// ── View 1: PO List ───────────────────────────────────────────────────────────
