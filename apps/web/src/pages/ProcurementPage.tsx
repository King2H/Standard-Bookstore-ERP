import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

type Role = string;

// ── Types ─────────────────────────────────────────────────────────────────────

interface POLineItem {
  id: string; poId: string; bookId: number; bookTitle: string; bookIsbn: string;
  formatId: number | null; editionId: number | null; quantity: number; unitCost: number;
  receivedQuantity: number; remaining: number;
}
interface POReceiptItem { id: string; receiptId: string; poLineItemId: string; bookTitle: string; quantityReceived: number; }
interface POReceipt { id: string; poId: string; locationId: number; locationName: string; receivedBy: number; receivedAt: string; notes: string | null; items: POReceiptItem[]; }
interface PO {
  id: string; branchId: number; supplierId: number; supplierName: string;
  status: string; totalAmount: number; currency: string;
  expectedDeliveryDate: string | null; notes: string | null;
  receivingBranchId: number | null; receivingLocationId: number | null;
  receivingLocationName: string | null; financialStatus: 'unpaid' | 'partial' | 'paid';
  createdBy: number; approvedBy: number | null; createdAt: string; updatedAt: string;
  lineItems?: POLineItem[]; receipts?: POReceipt[];
}
interface POListResponse { items: PO[]; total: number; page: number; totalPages: number; }
interface Supplier { id: number; name: string; isActive: boolean; isBlacklisted: boolean; }
interface Book { id: number; title: string; isbn: string; isActive: boolean; }
interface Location { id: number; name: string; branchId: number; isDefaultFulfillment: boolean; }

interface ProcurementPageProps { userRole?: Role; }

// ── RBAC helpers ──────────────────────────────────────────────────────────────

const canWrite = (r?: Role) => ['Admin', 'Manager', 'Purchasor'].includes(r ?? '');
const canApprove = (r?: Role) => ['Admin', 'Manager'].includes(r ?? '');
const canReceive = (r?: Role) => ['Admin', 'Manager', 'Stock_Clerk'].includes(r ?? '');
const canClose = (r?: Role) => ['Admin', 'Manager'].includes(r ?? '');

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  pending_approval: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  approved: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  ordered: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
  partially_received: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  received: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  closed: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-700'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

// ── Line item form row ────────────────────────────────────────────────────────

interface LineItemFormRow { bookId: number | null; bookTitle: string; quantity: number; unitCost: number; }

const EMPTY_LINE: LineItemFormRow = { bookId: null, bookTitle: '', quantity: 1, unitCost: 0 };

// ── View 4: Create/Edit PO Form ───────────────────────────────────────────────

function POForm({ editing, onSaved, onCancel }: { editing?: PO; onSaved: (po: PO) => void; onCancel: () => void }) {
  const { showToast } = useToast();
  const [supplierId, setSupplierId] = useState<number | null>(editing?.supplierId ?? null);
  const [currency, setCurrency] = useState(editing?.currency ?? 'USD');
  const [expectedDate, setExpectedDate] = useState(editing?.expectedDeliveryDate ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [receivingBranchId, setReceivingBranchId] = useState<number | null>(editing?.receivingBranchId ?? null);
  const [receivingLocationId, setReceivingLocationId] = useState<number | null>(editing?.receivingLocationId ?? null);
  const [lineItems, setLineItems] = useState<LineItemFormRow[]>(
    editing?.lineItems?.map(li => ({ bookId: li.bookId, bookTitle: li.bookTitle, quantity: li.quantity, unitCost: li.unitCost })) ?? [{ ...EMPTY_LINE }],
  );
  const [bookSearch, setBookSearch] = useState<string[]>(lineItems.map(li => li.bookTitle));

  const { data: suppliersData } = useQuery<{ items: Supplier[] }>({
    queryKey: ['suppliers-for-po'],
    queryFn: () => api.get('/suppliers?isActive=true&isBlacklisted=false&pageSize=200'),
  });

  const { data: booksData } = useQuery<{ items: Book[] }>({
    queryKey: ['books-for-po', bookSearch.join(',')],
    queryFn: () => api.get(`/books?pageSize=200`),
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
  const books = booksData?.items ?? [];
  const branches = branchesData?.items ?? [];
  const receivingLocations = receivingLocData?.items ?? [];
  const total = lineItems.reduce((s, li) => s + li.quantity * li.unitCost, 0);
  const busy = createMut.isPending || updateMut.isPending;

  function addLine() { setLineItems(l => [...l, { ...EMPTY_LINE }]); setBookSearch(b => [...b, '']); }
  function removeLine(i: number) { setLineItems(l => l.filter((_, idx) => idx !== i)); setBookSearch(b => b.filter((_, idx) => idx !== i)); }
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
      currency,
      expectedDeliveryDate: expectedDate || null,
      notes: notes || null,
      receivingBranchId: receivingBranchId || null,
      receivingLocationId: receivingLocationId || null,
      lineItems: validLines.map(li => ({ bookId: li.bookId, quantity: li.quantity, unitCost: li.unitCost })),
    };
    editing ? updateMut.mutate(body) : createMut.mutate(body);
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
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
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Select supplier...</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Currency</label>
              <input value={currency} onChange={e => setCurrency(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Expected Delivery</label>
              <input type="date" value={expectedDate} onChange={e => setExpectedDate(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
              <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Receiving Branch</label>
              <select value={receivingBranchId ?? ''} onChange={e => { setReceivingBranchId(Number(e.target.value) || null); setReceivingLocationId(null); }}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Same as order branch (default)</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            {receivingBranchId && (
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Receiving Location</label>
                <select value={receivingLocationId ?? ''} onChange={e => setReceivingLocationId(Number(e.target.value) || null)}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
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
                <select value={li.bookId ?? ''} onChange={e => { const b = books.find(bk => bk.id === Number(e.target.value)); updateLine(i, 'bookId', Number(e.target.value) || null); if (b) updateLine(i, 'bookTitle', b.title); }}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Select book...</option>
                  {books.filter(b => b.isActive).map(b => <option key={b.id} value={b.id}>{b.title}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Qty</label>
                <input type="number" min={1} value={li.quantity} onChange={e => updateLine(i, 'quantity', Math.max(1, Number(e.target.value)))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="col-span-3">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Unit Cost</label>
                <input type="number" min={0} step="0.01" value={li.unitCost} onChange={e => updateLine(i, 'unitCost', Math.max(0, Number(e.target.value)))}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
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

function ReceiveForm({ po: poProp, onDone, onBack }: { po: PO; onDone: (updated: PO) => void; onBack: () => void }) {
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
    <div className="p-6 max-w-2xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back to PO</button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Receive Goods — PO #{poProp.id}</h2>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Destination Location *</label>
            <select required value={locationId ?? ''} onChange={e => setLocationId(Number(e.target.value) || null)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">Select location...</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}{l.isDefaultFulfillment ? ' (default)' : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
            <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
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
                      className="w-20 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
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

// ── View 2: PO Detail ─────────────────────────────────────────────────────────

function PODetail({ poId, userRole, onBack, onEdit, onReceive }: {
  poId: string; userRole?: Role; onBack: () => void;
  onEdit: (po: PO) => void; onReceive: (po: PO) => void;
}) {
  const { showToast } = useToast();
  const qc = useQueryClient();

  const { data: po, isLoading } = useQuery<PO>({
    queryKey: ['po', poId],
    queryFn: () => api.get(`/purchase-orders/${poId}`),
  });

  const inv = () => { qc.invalidateQueries({ queryKey: ['po', poId] }); qc.invalidateQueries({ queryKey: ['purchase-orders'] }); };

  const submitMut = useMutation({ mutationFn: () => api.post<PO>(`/purchase-orders/${poId}/submit`), onSuccess: () => { inv(); showToast('Submitted for approval', 'success'); }, onError: (e: Error) => showToast(e.message, 'error') });
  const approveMut = useMutation({ mutationFn: () => api.post<PO>(`/purchase-orders/${poId}/approve`), onSuccess: () => { inv(); showToast('PO approved', 'success'); }, onError: (e: Error) => showToast(e.message, 'error') });
  const orderMut = useMutation({ mutationFn: () => api.post<PO>(`/purchase-orders/${poId}/order`), onSuccess: () => { inv(); showToast('Marked as ordered', 'success'); }, onError: (e: Error) => showToast(e.message, 'error') });
  const closeMut = useMutation({ mutationFn: () => api.post<PO>(`/purchase-orders/${poId}/close`), onSuccess: () => { inv(); showToast('PO closed', 'success'); }, onError: (e: Error) => showToast(e.message, 'error') });
  const cancelMut = useMutation({ mutationFn: () => api.post<PO>(`/purchase-orders/${poId}/cancel`), onSuccess: () => { inv(); showToast('PO cancelled', 'success'); onBack(); }, onError: (e: Error) => showToast(e.message, 'error') });

  if (isLoading) return <div className="p-8 text-center text-gray-400">Loading...</div>;
  if (!po) return <div className="p-8 text-center text-gray-400">PO not found.</div>;

  const status = po.status;

  return (
    <div className="p-6 space-y-5 max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back to List</button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">PO #{po.id}</h2>
        <StatusBadge status={status} />
      </div>

      {/* Header info */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 grid grid-cols-2 gap-4 text-sm">
        <div><span className="text-gray-500 dark:text-gray-400">Supplier:</span> <span className="font-medium text-gray-900 dark:text-white ml-1">{po.supplierName}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">Total:</span> <span className="font-medium text-gray-900 dark:text-white ml-1">{po.currency} {Number(po.totalAmount).toFixed(2)}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">Expected Delivery:</span> <span className="font-medium text-gray-900 dark:text-white ml-1">{po.expectedDeliveryDate ?? '—'}</span></div>
        <div><span className="text-gray-500 dark:text-gray-400">Created:</span> <span className="font-medium text-gray-900 dark:text-white ml-1">{new Date(po.createdAt).toLocaleDateString()}</span></div>
        {po.receivingLocationName && (
          <div>
            <span className="text-gray-500 dark:text-gray-400">Receiving Location:</span>
            <span className="font-medium text-gray-900 dark:text-white ml-1">{po.receivingLocationName}</span>
          </div>
        )}
        <div>
          <span className="text-gray-500 dark:text-gray-400">Payment Status:</span>
          <span className={`ml-1 text-xs font-medium px-2 py-0.5 rounded-full ${po.financialStatus === 'paid' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : po.financialStatus === 'partial' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
            {po.financialStatus}
          </span>
        </div>
        {po.notes && <div className="col-span-2"><span className="text-gray-500 dark:text-gray-400">Notes:</span> <span className="text-gray-900 dark:text-white ml-1">{po.notes}</span></div>}
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        {status === 'draft' && canWrite(userRole) && <>
          <button onClick={() => onEdit(po)} className="px-4 py-2 text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Edit</button>
          <button onClick={() => submitMut.mutate()} disabled={submitMut.isPending} className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">Submit for Approval</button>
          <button onClick={() => { if (confirm('Cancel this PO?')) cancelMut.mutate(); }} disabled={cancelMut.isPending} className="px-4 py-2 text-sm font-medium bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded-lg hover:bg-red-200 dark:hover:bg-red-800 transition-colors">Cancel</button>
        </>}
        {status === 'pending_approval' && <>
          {canApprove(userRole) && <button onClick={() => approveMut.mutate()} disabled={approveMut.isPending} className="px-4 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors">Approve</button>}
          {canWrite(userRole) && <button onClick={() => { if (confirm('Cancel this PO?')) cancelMut.mutate(); }} disabled={cancelMut.isPending} className="px-4 py-2 text-sm font-medium bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded-lg hover:bg-red-200 dark:hover:bg-red-800 transition-colors">Cancel</button>}
        </>}
        {status === 'approved' && <>
          {canWrite(userRole) && <button onClick={() => orderMut.mutate()} disabled={orderMut.isPending} className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors">Mark as Ordered</button>}
          {canReceive(userRole) && <button onClick={() => onReceive(po)} className="px-4 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">Receive Goods</button>}
          {canWrite(userRole) && <button onClick={() => { if (confirm('Cancel this PO?')) cancelMut.mutate(); }} disabled={cancelMut.isPending} className="px-4 py-2 text-sm font-medium bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded-lg hover:bg-red-200 dark:hover:bg-red-800 transition-colors">Cancel</button>}
        </>}
        {status === 'ordered' && <>
          {canReceive(userRole) && <button onClick={() => onReceive(po)} className="px-4 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">Receive Goods</button>}
          {canWrite(userRole) && <button onClick={() => { if (confirm('Cancel this PO?')) cancelMut.mutate(); }} disabled={cancelMut.isPending} className="px-4 py-2 text-sm font-medium bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded-lg hover:bg-red-200 dark:hover:bg-red-800 transition-colors">Cancel</button>}
        </>}
        {status === 'partially_received' && canReceive(userRole) && (
          <button onClick={() => onReceive(po)} className="px-4 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">Receive More Goods</button>
        )}
        {status === 'received' && canClose(userRole) && (
          <button onClick={() => closeMut.mutate()} disabled={closeMut.isPending} className="px-4 py-2 text-sm font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 transition-colors">Close PO</button>
        )}
      </div>

      {/* Line items */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Line Items</h3>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>{['Book', 'ISBN', 'Ordered', 'Received', 'Remaining', 'Unit Cost', 'Line Total'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {(po.lineItems ?? []).map(li => (
              <tr key={li.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="px-4 py-3 text-gray-900 dark:text-white">{li.bookTitle}</td>
                <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">{li.bookIsbn}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.quantity}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.receivedQuantity}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{li.remaining}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{Number(li.unitCost).toFixed(2)}</td>
                <td className="px-4 py-3 text-gray-900 dark:text-white font-medium">{(li.quantity * li.unitCost).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Receipts */}
      {(po.receipts ?? []).length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Receipts (GRNs)</h3>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {(po.receipts ?? []).map(r => (
              <div key={r.id} className="p-4 space-y-2">
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-medium text-gray-900 dark:text-white">Receipt #{r.id}</span>
                  <span className="text-gray-500 dark:text-gray-400">{r.locationName}</span>
                  <span className="text-gray-500 dark:text-gray-400">{new Date(r.receivedAt).toLocaleString()}</span>
                  {r.notes && <span className="text-gray-500 dark:text-gray-400 italic">{r.notes}</span>}
                </div>
                <div className="pl-4 space-y-1">
                  {r.items.map(ri => (
                    <div key={ri.id} className="text-xs text-gray-600 dark:text-gray-400">
                      {ri.bookTitle}: {ri.quantityReceived} units
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── View 1: PO List ───────────────────────────────────────────────────────────

type View = 'list' | 'detail' | 'receive' | 'form';

export default function ProcurementPage({ userRole }: ProcurementPageProps) {
  const qc = useQueryClient();
  const [view, setView] = useState<View>('list');
  const [selectedPO, setSelectedPO] = useState<PO | null>(null);
  const [editingPO, setEditingPO] = useState<PO | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterSupplier, setFilterSupplier] = useState('');

  const params = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (filterStatus) params.set('status', filterStatus);

  const { data, isLoading } = useQuery<POListResponse>({
    queryKey: ['purchase-orders', page, filterStatus],
    queryFn: () => api.get(`/purchase-orders?${params}`),
  });

  const pos = (data?.items ?? []).filter(po =>
    !filterSupplier || po.supplierName.toLowerCase().includes(filterSupplier.toLowerCase()),
  );

  function openDetail(po: PO) { setSelectedPO(po); setView('detail'); }
  function openReceive(po: PO) { setSelectedPO(po); setView('receive'); }
  function openCreate() { setEditingPO(undefined); setView('form'); }
  function openEdit(po: PO) { setEditingPO(po); setView('form'); }
  function backToList() { setView('list'); setSelectedPO(null); qc.invalidateQueries({ queryKey: ['purchase-orders'] }); }

  if (view === 'form') {
    return <POForm editing={editingPO} onSaved={(po) => { openDetail(po); }} onCancel={backToList} />;
  }

  if (view === 'detail' && selectedPO) {
    return (
      <PODetail
        poId={selectedPO.id}
        userRole={userRole}
        onBack={backToList}
        onEdit={openEdit}
        onReceive={openReceive}
      />
    );
  }

  if (view === 'receive' && selectedPO) {
    return (
      <ReceiveForm
        po={selectedPO}
        onDone={(updated) => { setSelectedPO(updated); setView('detail'); qc.invalidateQueries({ queryKey: ['purchase-orders'] }); }}
        onBack={() => setView('detail')}
      />
    );
  }

  // List view
  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by supplier..."
          value={filterSupplier}
          onChange={e => setFilterSupplier(e.target.value)}
          className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white w-56 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          value={filterStatus}
          onChange={e => { setFilterStatus(e.target.value); setPage(1); }}
          className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Statuses</option>
          {['draft','pending_approval','approved','ordered','partially_received','received','closed','cancelled'].map(s => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-gray-500 dark:text-gray-400">{data?.total ?? 0} orders</span>
          {canWrite(userRole) && (
            <button onClick={openCreate} className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              + New PO
            </button>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : pos.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No purchase orders found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                {['ID', 'Supplier', 'Status', 'Total', 'Expected Date', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {pos.map(po => (
                <tr key={po.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">#{po.id}</td>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{po.supplierName}</td>
                  <td className="px-4 py-3"><StatusBadge status={po.status} /></td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{po.currency} {Number(po.totalAmount).toFixed(2)}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{po.expectedDeliveryDate ?? '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 text-xs">
                      <button onClick={() => openDetail(po)} className="px-2 py-1 rounded text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors">View</button>
                      {po.status === 'draft' && canWrite(userRole) && (
                        <button onClick={() => openEdit(po)} className="px-2 py-1 rounded text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">Edit</button>
                      )}
                      {['approved', 'ordered', 'partially_received'].includes(po.status) && canReceive(userRole) && (
                        <button onClick={() => openReceive(po)} className="px-2 py-1 rounded text-green-600 hover:bg-green-50 dark:hover:bg-green-950 transition-colors">Receive</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
          <span>Page {data.page} of {data.totalPages}</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Prev</button>
            <button disabled={page >= data.totalPages} onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
