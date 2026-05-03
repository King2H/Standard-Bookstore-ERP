import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

type Role = string;
interface Supplier { id: number; name: string; contactInfo: Record<string, string>; leadTimeDays: number; pricingTerms: string | null; supplierType: 'external' | 'publisher'; publisherId: number | null; publisherName: string | null; isActive: boolean; isBlacklisted: boolean; createdAt: string; }
interface Publisher { id: number; name: string; }
interface SupplierListResponse { items: Supplier[]; total: number; page: number; totalPages: number; }
interface SupplierPayload { name: string; contactInfo: { phone: string; email: string }; leadTimeDays: number; pricingTerms: string | null; supplierType: 'external' | 'publisher'; publisherId: number | null; }
interface SuppliersPageProps { userRole?: Role; }

const canWrite = (r?: Role) => ['Admin', 'Manager', 'Purchasor', 'Stock_Clerk'].includes(r ?? '');
const canBlacklist = (r?: Role) => ['Super_Admin', 'Admin', 'Manager'].includes(r ?? '');
const EMPTY = { name: '', contactPhone: '', contactEmail: '', leadTimeDays: 7, pricingTerms: '', supplierType: 'external' as 'external' | 'publisher', publisherId: null as number | null };

export default function SuppliersPage({ userRole }: SuppliersPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterActive, setFilterActive] = useState('');
  const [filterBlacklisted, setFilterBlacklisted] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [form, setForm] = useState({ ...EMPTY });

  const params = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (q) params.set('q', q);
  if (filterType) params.set('supplierType', filterType);
  if (filterActive) params.set('isActive', filterActive);
  if (filterBlacklisted) params.set('isBlacklisted', filterBlacklisted);

  const { data, isLoading } = useQuery<SupplierListResponse>({ queryKey: ['suppliers', page, q, filterType, filterActive, filterBlacklisted], queryFn: () => api.get(`/suppliers?${params}`) });
  const { data: pubData } = useQuery<{ items: Publisher[] }>({ queryKey: ['publishers-list'], queryFn: () => api.get('/publishers?pageSize=200'), enabled: drawerOpen });

  const inv = () => qc.invalidateQueries({ queryKey: ['suppliers'] });
  const createMut = useMutation({ mutationFn: (b: SupplierPayload) => api.post<Supplier>('/suppliers', b), onSuccess: () => { inv(); closeDrawer(); showToast('Supplier created', 'success'); }, onError: (e: Error) => showToast(e.message, 'error') });
  const updateMut = useMutation({ mutationFn: ({ id, b }: { id: number; b: SupplierPayload }) => api.put<Supplier>(`/suppliers/${id}`, b), onSuccess: () => { inv(); closeDrawer(); showToast('Supplier updated', 'success'); }, onError: (e: Error) => showToast(e.message, 'error') });
  const deactivateMut = useMutation({ mutationFn: (id: number) => api.post(`/suppliers/${id}/deactivate`), onSuccess: () => { inv(); showToast('Deactivated', 'success'); }, onError: (e: Error) => showToast(e.message, 'error') });
  const blacklistMut = useMutation({ mutationFn: (id: number) => api.post(`/suppliers/${id}/blacklist`), onSuccess: () => { inv(); showToast('Blacklisted', 'success'); }, onError: (e: Error) => showToast(e.message, 'error') });
  const deleteMut = useMutation({ mutationFn: (id: number) => api.delete(`/suppliers/${id}`), onSuccess: () => { inv(); showToast('Deleted', 'success'); }, onError: (e: Error) => showToast(e.message, 'error') });

  function closeDrawer() { setDrawerOpen(false); setEditing(null); }
  function openCreate() { setEditing(null); setForm({ ...EMPTY }); setDrawerOpen(true); }
  function openEdit(s: Supplier) { setEditing(s); setForm({ name: s.name, contactPhone: s.contactInfo.phone ?? '', contactEmail: s.contactInfo.email ?? '', leadTimeDays: s.leadTimeDays, pricingTerms: s.pricingTerms ?? '', supplierType: s.supplierType, publisherId: s.publisherId }); setDrawerOpen(true); }
  function mkPayload(): SupplierPayload { return { name: form.name, contactInfo: { phone: form.contactPhone, email: form.contactEmail }, leadTimeDays: form.leadTimeDays, pricingTerms: form.pricingTerms || null, supplierType: form.supplierType, publisherId: form.supplierType === 'publisher' ? form.publisherId : null }; }
  function handleSubmit(e: React.FormEvent) { e.preventDefault(); const p = mkPayload(); editing ? updateMut.mutate({ id: editing.id, b: p }) : createMut.mutate(p); }

  const suppliers = data?.items ?? [];
  const publishers = pubData?.items ?? [];
  const busy = createMut.isPending || updateMut.isPending;

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input type="text" placeholder="Search suppliers..." value={q} onChange={e => { setQ(e.target.value); setPage(1); }} className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white w-56 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <select value={filterType} onChange={e => { setFilterType(e.target.value); setPage(1); }} className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white"><option value="">All Types</option><option value="external">External</option><option value="publisher">Publisher</option></select>
        <select value={filterActive} onChange={e => { setFilterActive(e.target.value); setPage(1); }} className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white"><option value="">All Status</option><option value="true">Active</option><option value="false">Inactive</option></select>
        <select value={filterBlacklisted} onChange={e => { setFilterBlacklisted(e.target.value); setPage(1); }} className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white"><option value="">All</option><option value="false">Not Blacklisted</option><option value="true">Blacklisted</option></select>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-gray-500 dark:text-gray-400">{data?.total ?? 0} suppliers</span>
          {canWrite(userRole) && <button onClick={openCreate} className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">+ New Supplier</button>}
        </div>
      </div>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {isLoading ? <div className="p-8 text-center text-gray-400">Loading...</div> : suppliers.length === 0 ? <div className="p-8 text-center text-gray-400">No suppliers found.</div> : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700"><tr>{['Name', 'Type', 'Lead Time', 'Contact', 'Status', 'Actions'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {suppliers.map(s => (
                <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{s.name}{s.isBlacklisted && <span className="ml-2 text-xs bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300 px-1.5 py-0.5 rounded">Blacklisted</span>}</td>
                  <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${s.supplierType === 'publisher' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'}`}>{s.supplierType === 'publisher' ? `Publisher${s.publisherName ? ` - ${s.publisherName}` : ''}` : 'External'}</span></td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{s.leadTimeDays}d</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs">{s.contactInfo.email && <div>{s.contactInfo.email}</div>}{s.contactInfo.phone && <div>{s.contactInfo.phone}</div>}</td>
                  <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${s.isActive ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>{s.isActive ? 'Active' : 'Inactive'}</span></td>
                  <td className="px-4 py-3"><div className="flex items-center gap-1 text-xs">
                    {canWrite(userRole) && <button onClick={() => openEdit(s)} className="px-2 py-1 rounded text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors">Edit</button>}
                    {canWrite(userRole) && s.isActive && <button onClick={() => { if (confirm(`Deactivate "${s.name}"?`)) deactivateMut.mutate(s.id); }} className="px-2 py-1 rounded text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-950 transition-colors">Deactivate</button>}
                    {canBlacklist(userRole) && !s.isBlacklisted && <button onClick={() => { if (confirm(`Blacklist "${s.name}"?`)) blacklistMut.mutate(s.id); }} className="px-2 py-1 rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">Blacklist</button>}
                    {canBlacklist(userRole) && <button onClick={() => { if (confirm(`Delete "${s.name}"?`)) deleteMut.mutate(s.id); }} className="px-2 py-1 rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">Delete</button>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {data && data.totalPages > 1 && <div className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400"><span>Page {data.page} of {data.totalPages}</span><div className="flex gap-2"><button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Prev</button><button disabled={page >= data.totalPages} onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800">Next</button></div></div>}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/40" onClick={closeDrawer} />
          <div className="w-full max-w-md bg-white dark:bg-gray-900 shadow-2xl flex flex-col overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">{editing ? 'Edit Supplier' : 'New Supplier'}</h2>
              <button onClick={closeDrawer} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">x</button>
            </div>
            <form onSubmit={handleSubmit} className="flex-1 p-6 space-y-4">
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Name *</label><input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Supplier Type *</label><select value={form.supplierType} onChange={e => setForm(f => ({ ...f, supplierType: e.target.value as 'external' | 'publisher', publisherId: null }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="external">External (Distributor / Wholesaler)</option><option value="publisher">Publisher (Direct from Publisher)</option></select></div>
              {form.supplierType === 'publisher' && <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Linked Publisher *</label><select required value={form.publisherId ?? ''} onChange={e => setForm(f => ({ ...f, publisherId: e.target.value ? Number(e.target.value) : null }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="">Select publisher...</option>{publishers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label><input type="email" value={form.contactEmail} onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
                <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Phone</label><input value={form.contactPhone} onChange={e => setForm(f => ({ ...f, contactPhone: e.target.value }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
              </div>
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Lead Time (days) *</label><input type="number" min={1} required value={form.leadTimeDays} onChange={e => setForm(f => ({ ...f, leadTimeDays: Number(e.target.value) }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Pricing Terms</label><textarea rows={2} value={form.pricingTerms} onChange={e => setForm(f => ({ ...f, pricingTerms: e.target.value }))} className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" /></div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={closeDrawer} className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Cancel</button>
                <button type="submit" disabled={busy} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">{busy ? 'Saving...' : editing ? 'Save Changes' : 'Create Supplier'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
