import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

type Role = string;

interface Customer {
  id: number; branchId: number | null; customerCode: string; fullName: string;
  phone: string | null; email: string | null; gender: string | null;
  dateOfBirth: string | null; address: string | null; city: string | null;
  isActive: boolean; createdAt: string;
  loyaltyBalance: number; lifetimePoints: number; storeCreditBalance: number;
  groups: Array<{ id: number; name: string; discountPct: number }>;
}

interface CustomerListResponse { items: Customer[]; total: number; page: number; totalPages: number; }
interface LoyaltyHistoryItem { id: number; pointsDelta: number; reason: string; transactionRef: string | null; createdAt: string; }
interface StoreCreditHistoryItem { id: number; amount: number; direction: 'credit' | 'debit'; refType: string | null; refId: string | null; createdAt: string; }
interface HistoryResponse<T> { items: T[]; total: number; page: number; totalPages: number; }

interface CustomersPageProps { userRole?: Role; }

const canWrite = (r?: string) => ['Admin', 'Manager', 'Sales'].includes(r ?? '');
const canDeactivate = (r?: string) => ['Admin', 'Manager'].includes(r ?? '');
const canAdjustCredit = (r?: string) => ['Admin', 'Finance_Officer'].includes(r ?? '');
const canRedeem = (r?: string) => ['Admin', 'Manager', 'Sales'].includes(r ?? '');

const EMPTY_FORM = { fullName: '', phone: '', email: '', gender: '', dateOfBirth: '', address: '', city: '', branchId: '' };

type View = 'list' | 'profile';
type ProfileTab = 'profile' | 'loyalty' | 'store-credit';

export default function CustomersPage({ userRole }: CustomersPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();

  // List state
  const [view, setView] = useState<View>('list');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [profileTab, setProfileTab] = useState<ProfileTab>('profile');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [filterActive, setFilterActive] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  // Edit form state
  const [editForm, setEditForm] = useState({ ...EMPTY_FORM });

  // Loyalty redeem state
  const [redeemPoints, setRedeemPoints] = useState('');
  const [redeemRef, setRedeemRef] = useState('');

  // Store credit adjust state
  const [creditAmount, setCreditAmount] = useState('');
  const [creditDirection, setCreditDirection] = useState<'credit' | 'debit'>('credit');
  const [creditRefType, setCreditRefType] = useState('');
  const [creditRefId, setCreditRefId] = useState('');

  const params = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (q) params.set('q', q);
  if (filterActive) params.set('isActive', filterActive);

  const { data, isLoading } = useQuery<CustomerListResponse>({
    queryKey: ['customers', page, q, filterActive],
    queryFn: () => api.get(`/customers?${params}`),
  });

  const { data: loyaltyHistory } = useQuery<HistoryResponse<LoyaltyHistoryItem>>({
    queryKey: ['loyalty-history', selectedCustomer?.id],
    queryFn: () => api.get(`/customers/${selectedCustomer!.id}/loyalty/history`),
    enabled: !!selectedCustomer && profileTab === 'loyalty',
  });

  const { data: creditHistory } = useQuery<HistoryResponse<StoreCreditHistoryItem>>({
    queryKey: ['credit-history', selectedCustomer?.id],
    queryFn: () => api.get(`/customers/${selectedCustomer!.id}/store-credit/history`),
    enabled: !!selectedCustomer && profileTab === 'store-credit',
  });

  const inv = () => qc.invalidateQueries({ queryKey: ['customers'] });
  const invCustomer = (id: number) => qc.invalidateQueries({ queryKey: ['customer', id] });

  const createMut = useMutation({
    mutationFn: (b: typeof EMPTY_FORM) => api.post<Customer>('/customers', {
      fullName: b.fullName, phone: b.phone || null, email: b.email || null,
      gender: b.gender || null, dateOfBirth: b.dateOfBirth || null,
      address: b.address || null, city: b.city || null,
      branchId: b.branchId ? Number(b.branchId) : null,
    }),
    onSuccess: () => { inv(); setDrawerOpen(false); setForm({ ...EMPTY_FORM }); showToast('Customer created', 'success'); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, b }: { id: number; b: typeof EMPTY_FORM }) => api.put<Customer>(`/customers/${id}`, {
      fullName: b.fullName, phone: b.phone || null, email: b.email || null,
      gender: b.gender || null, dateOfBirth: b.dateOfBirth || null,
      address: b.address || null, city: b.city || null,
    }),
    onSuccess: (updated) => {
      inv(); invCustomer(updated.id);
      setSelectedCustomer(updated);
      showToast('Customer updated', 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const deactivateMut = useMutation({
    mutationFn: (id: number) => api.post(`/customers/${id}/deactivate`),
    onSuccess: () => {
      inv();
      if (selectedCustomer) {
        setSelectedCustomer(prev => prev ? { ...prev, isActive: false } : null);
      }
      showToast('Customer deactivated', 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const redeemMut = useMutation({
    mutationFn: ({ id, points, ref }: { id: number; points: number; ref: string }) =>
      api.post(`/customers/${id}/loyalty/redeem`, { points, transactionRef: ref || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty-history', selectedCustomer?.id] });
      // Refresh customer data
      if (selectedCustomer) {
        api.get<Customer>(`/customers/${selectedCustomer.id}`).then(c => setSelectedCustomer(c));
      }
      setRedeemPoints(''); setRedeemRef('');
      showToast('Points redeemed', 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const adjustCreditMut = useMutation({
    mutationFn: ({ id, amount, direction, refType, refId }: { id: number; amount: number; direction: 'credit' | 'debit'; refType: string; refId: string }) =>
      api.post(`/customers/${id}/store-credit/adjust`, { amount, direction, refType: refType || null, refId: refId || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credit-history', selectedCustomer?.id] });
      if (selectedCustomer) {
        api.get<Customer>(`/customers/${selectedCustomer.id}`).then(c => setSelectedCustomer(c));
      }
      setCreditAmount(''); setCreditRefType(''); setCreditRefId('');
      showToast('Store credit adjusted', 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  function openProfile(c: Customer) {
    setSelectedCustomer(c);
    setEditForm({
      fullName: c.fullName, phone: c.phone ?? '', email: c.email ?? '',
      gender: c.gender ?? '', dateOfBirth: c.dateOfBirth ?? '',
      address: c.address ?? '', city: c.city ?? '', branchId: String(c.branchId ?? ''),
    });
    setProfileTab('profile');
    setView('profile');
  }

  const customers = data?.items ?? [];

  // ── View: Customer List ──────────────────────────────────────────────────────
  if (view === 'list') {
    return (
      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <input type="text" placeholder="Search by name, phone, code..." value={q}
            onChange={e => { setQ(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white w-64 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <select value={filterActive} onChange={e => { setFilterActive(e.target.value); setPage(1); }}
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
            <option value="">All Status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-gray-500 dark:text-gray-400">{data?.total ?? 0} customers</span>
            {canWrite(userRole) && (
              <button onClick={() => { setForm({ ...EMPTY_FORM }); setDrawerOpen(true); }}
                className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
                + New Customer
              </button>
            )}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-gray-400">Loading...</div>
          ) : customers.length === 0 ? (
            <div className="p-8 text-center text-gray-400">No customers found.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <tr>{['Code', 'Name', 'Phone', 'Loyalty Pts', 'Store Credit', 'Status', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {customers.map(c => (
                  <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{c.customerCode}</td>
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{c.fullName}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{c.phone ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{c.loyaltyBalance.toFixed(0)}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">${c.storeCreditBalance.toFixed(2)}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${c.isActive ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
                        {c.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 text-xs">
                        <button onClick={() => openProfile(c)} className="px-2 py-1 rounded text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors">View</button>
                        {canDeactivate(userRole) && c.isActive && (
                          <button onClick={() => { if (confirm(`Deactivate "${c.fullName}"?`)) deactivateMut.mutate(c.id); }}
                            className="px-2 py-1 rounded text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-950 transition-colors">Deactivate</button>
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

        {/* Create Customer Drawer */}
        {drawerOpen && (
          <div className="fixed inset-0 z-50 flex">
            <div className="flex-1 bg-black/40" onClick={() => setDrawerOpen(false)} />
            <div className="w-full max-w-md bg-white dark:bg-gray-900 shadow-2xl flex flex-col overflow-y-auto">
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
                <h2 className="text-base font-semibold text-gray-900 dark:text-white">New Customer</h2>
                <button onClick={() => setDrawerOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
              </div>
              <form onSubmit={e => { e.preventDefault(); createMut.mutate(form); }} className="flex-1 p-6 space-y-4">
                <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Full Name *</label>
                  <input required value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Phone</label>
                    <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
                  <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
                    <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Gender</label>
                    <select value={form.gender} onChange={e => setForm(f => ({ ...f, gender: e.target.value }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="">Select...</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option>
                    </select></div>
                  <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Date of Birth</label>
                    <input type="date" value={form.dateOfBirth} onChange={e => setForm(f => ({ ...f, dateOfBirth: e.target.value }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
                </div>
                <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Address</label>
                  <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
                <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">City</label>
                  <input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
                <div className="flex gap-3 pt-2">
                  <button type="button" onClick={() => setDrawerOpen(false)} className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Cancel</button>
                  <button type="submit" disabled={createMut.isPending} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">{createMut.isPending ? 'Saving...' : 'Create Customer'}</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── View: Customer Profile ───────────────────────────────────────────────────
  const c = selectedCustomer!;
  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button onClick={() => setView('list')} className="text-sm text-blue-600 hover:underline">← Back to List</button>
        <span className="font-mono text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-2 py-1 rounded">{c.customerCode}</span>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{c.fullName}</h2>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${c.isActive ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
          {c.isActive ? 'Active' : 'Inactive'}
        </span>
        {canDeactivate(userRole) && c.isActive && (
          <button onClick={() => { if (confirm(`Deactivate "${c.fullName}"?`)) deactivateMut.mutate(c.id); }}
            className="ml-auto text-sm text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-950 px-3 py-1.5 rounded-lg border border-yellow-300 dark:border-yellow-700 transition-colors">
            Deactivate
          </button>
        )}
      </div>

      {/* Groups */}
      {c.groups.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {c.groups.map(g => (
            <span key={g.id} className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 px-2 py-0.5 rounded-full">
              {g.name} {g.discountPct > 0 ? `(${g.discountPct}% off)` : ''}
            </span>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {(['profile', 'loyalty', 'store-credit'] as ProfileTab[]).map(tab => (
          <button key={tab} onClick={() => setProfileTab(tab)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${profileTab === tab ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {tab === 'store-credit' ? 'Store Credit' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Tab: Profile */}
      {profileTab === 'profile' && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
          <form onSubmit={e => { e.preventDefault(); updateMut.mutate({ id: c.id, b: editForm }); }} className="space-y-4">
            <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Full Name *</label>
              <input required value={editForm.fullName} onChange={e => setEditForm(f => ({ ...f, fullName: e.target.value }))} disabled={!canWrite(userRole)} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Phone</label>
                <input value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))} disabled={!canWrite(userRole)} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60" /></div>
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
                <input type="email" value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} disabled={!canWrite(userRole)} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60" /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Gender</label>
                <select value={editForm.gender} onChange={e => setEditForm(f => ({ ...f, gender: e.target.value }))} disabled={!canWrite(userRole)} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60">
                  <option value="">Select...</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option>
                </select></div>
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Date of Birth</label>
                <input type="date" value={editForm.dateOfBirth} onChange={e => setEditForm(f => ({ ...f, dateOfBirth: e.target.value }))} disabled={!canWrite(userRole)} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60" /></div>
            </div>
            <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Address</label>
              <input value={editForm.address} onChange={e => setEditForm(f => ({ ...f, address: e.target.value }))} disabled={!canWrite(userRole)} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60" /></div>
            <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">City</label>
              <input value={editForm.city} onChange={e => setEditForm(f => ({ ...f, city: e.target.value }))} disabled={!canWrite(userRole)} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60" /></div>
            {canWrite(userRole) && (
              <button type="submit" disabled={updateMut.isPending} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-6 py-2 rounded-lg transition-colors">
                {updateMut.isPending ? 'Saving...' : 'Save Changes'}
              </button>
            )}
          </form>
        </div>
      )}

      {/* Tab: Loyalty */}
      {profileTab === 'loyalty' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Points Balance</p>
              <p className="text-3xl font-bold text-blue-600 dark:text-blue-400">{c.loyaltyBalance.toFixed(0)}</p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Lifetime Earned</p>
              <p className="text-3xl font-bold text-green-600 dark:text-green-400">{c.lifetimePoints.toFixed(0)}</p>
            </div>
          </div>

          {canRedeem(userRole) && (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Redeem Points</h3>
              <div className="flex gap-3 items-end">
                <div className="flex-1"><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Points</label>
                  <input type="number" min="1" value={redeemPoints} onChange={e => setRedeemPoints(e.target.value)} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
                <div className="flex-1"><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Transaction Ref</label>
                  <input value={redeemRef} onChange={e => setRedeemRef(e.target.value)} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
                <button disabled={!redeemPoints || redeemMut.isPending}
                  onClick={() => redeemMut.mutate({ id: c.id, points: Number(redeemPoints), ref: redeemRef })}
                  className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
                  {redeemMut.isPending ? 'Redeeming...' : 'Redeem'}
                </button>
              </div>
            </div>
          )}

          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Loyalty History</h3>
            </div>
            {!loyaltyHistory ? (
              <div className="p-6 text-center text-gray-400 text-sm">Loading...</div>
            ) : loyaltyHistory.items.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-sm">No history yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800"><tr>
                  {['Date', 'Delta', 'Reason', 'Ref'].map(h => <th key={h} className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">{h}</th>)}
                </tr></thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {loyaltyHistory.items.map((h: LoyaltyHistoryItem) => (
                    <tr key={h.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-4 py-2 text-gray-600 dark:text-gray-400 text-xs">{new Date(h.createdAt).toLocaleDateString()}</td>
                      <td className={`px-4 py-2 font-medium ${h.pointsDelta >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {h.pointsDelta >= 0 ? '+' : ''}{h.pointsDelta}
                      </td>
                      <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{h.reason}</td>
                      <td className="px-4 py-2 text-gray-500 dark:text-gray-500 text-xs">{h.transactionRef ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Tab: Store Credit */}
      {profileTab === 'store-credit' && (
        <div className="space-y-4">
          {/* Balance cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Pre-paid store credit balance */}
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Pre-paid Store Credit</p>
              <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">ETB {c.storeCreditBalance.toFixed(2)}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Available to spend</p>
            </div>
            {/* Outstanding POS credit debt */}
            {creditHistory && (() => {
              const posDebits = creditHistory.items
                .filter((h: StoreCreditHistoryItem) => h.refType === 'pos_credit_sale')
                .reduce((s: number, h: StoreCreditHistoryItem) => s + h.amount, 0);
              const posCredits = creditHistory.items
                .filter((h: StoreCreditHistoryItem) => h.refType === 'pos_credit_settlement')
                .reduce((s: number, h: StoreCreditHistoryItem) => s + h.amount, 0);
              const outstanding = Math.max(0, posDebits - posCredits);
              return (
                <div className={`bg-white dark:bg-gray-900 rounded-xl border p-6 text-center ${outstanding > 0 ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20' : 'border-gray-200 dark:border-gray-800'}`}>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Outstanding Credit Sales</p>
                  <p className={`text-3xl font-bold ${outstanding > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}`}>
                    ETB {outstanding.toFixed(2)}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    {outstanding > 0 ? '⚠️ Amount owed to store' : '✓ No outstanding debt'}
                  </p>
                </div>
              );
            })()}

          </div>

          {canAdjustCredit(userRole) && (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Manual Adjustment</h3>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Amount</label>
                  <input type="number" min="0.01" step="0.01" value={creditAmount} onChange={e => setCreditAmount(e.target.value)} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
                <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Direction</label>
                  <select value={creditDirection} onChange={e => setCreditDirection(e.target.value as 'credit' | 'debit')} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="credit">Credit (Add)</option>
                    <option value="debit">Debit (Subtract)</option>
                  </select></div>
                <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Ref Type</label>
                  <input value={creditRefType} onChange={e => setCreditRefType(e.target.value)} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
                <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Ref ID</label>
                  <input value={creditRefId} onChange={e => setCreditRefId(e.target.value)} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
              </div>
              <button disabled={!creditAmount || adjustCreditMut.isPending}
                onClick={() => adjustCreditMut.mutate({ id: c.id, amount: Number(creditAmount), direction: creditDirection, refType: creditRefType, refId: creditRefId })}
                className="mt-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
                {adjustCreditMut.isPending ? 'Applying...' : 'Apply Adjustment'}
              </button>
            </div>
          )}

          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Store Credit History</h3>
            </div>
            {!creditHistory ? (
              <div className="p-6 text-center text-gray-400 text-sm">Loading...</div>
            ) : creditHistory.items.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-sm">No history yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800"><tr>
                  {['Date', 'Amount', 'Direction', 'Ref Type', 'Ref ID'].map(h => <th key={h} className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">{h}</th>)}
                </tr></thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {creditHistory.items.map((h: StoreCreditHistoryItem) => (
                    <tr key={h.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-4 py-2 text-gray-600 dark:text-gray-400 text-xs">{new Date(h.createdAt).toLocaleDateString()}</td>
                      <td className="px-4 py-2 font-medium text-gray-900 dark:text-white">${h.amount.toFixed(2)}</td>
                      <td className="px-4 py-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${h.direction === 'credit' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>
                          {h.direction === 'credit' ? '+ Credit' : '− Debit'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-500 dark:text-gray-500 text-xs">
                        {h.refType === 'pos_credit_sale' ? '🛒 POS Credit Sale'
                          : h.refType === 'pos_credit_settlement' ? '✅ POS Settlement'
                          : h.refType === 'transaction' ? '💳 Store Credit Used'
                          : h.refType === 'exchange_refund' ? '🔁 Exchange Refund'
                          : h.refType === 'exchange_payment' ? '🔁 Exchange Payment'
                          : h.refType === 'manual' ? '✏️ Manual Adjustment'
                          : h.refType ?? '—'}
                      </td>
                      <td className="px-4 py-2 text-gray-500 dark:text-gray-500 text-xs font-mono">{h.refId ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
