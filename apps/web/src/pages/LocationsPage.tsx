import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getAccessToken } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

interface Location {
  id: number;
  branchId: number;
  name: string;
  isDefaultFulfillment: boolean;
  createdAt: string;
}

interface Branch { id: number; name: string; isActive: boolean }

const inputCls = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors';

export default function LocationsPage({ userRole }: { userRole?: string }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [selectedBranchId, setSelectedBranchId] = useState<number | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const canWrite = userRole && ['Super_Admin', 'Admin', 'Manager'].includes(userRole);

  const { data: branchData } = useQuery({
    queryKey: ['branches'],
    queryFn: () => api.get<{ items: Branch[] }>('/branches'),
    enabled: !!getAccessToken(),
    staleTime: 60_000,
  });

  const branches = branchData?.items.filter(b => b.isActive) ?? [];
  const activeBranchId = selectedBranchId ?? branches[0]?.id ?? null;

  const { data: locationsData, isLoading } = useQuery({
    queryKey: ['locations', activeBranchId],
    queryFn: () => api.get<{ items: Location[]; total: number }>(`/branches/${activeBranchId}/locations`),
    enabled: !!activeBranchId && !!getAccessToken(),
    staleTime: 30_000,
  });

  const locations = locationsData?.items ?? [];

  const createMutation = useMutation({
    mutationFn: (name: string) => api.post<Location>(`/branches/${activeBranchId}/locations`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locations', activeBranchId] });
      setShowCreateForm(false);
      setNewName('');
      showToast('Location created');
    },
    onError: (err: unknown) => showToast((err as { message?: string }).message ?? 'Failed to create location', 'error'),
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.put<Location>(`/branches/${activeBranchId}/locations/${id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locations', activeBranchId] });
      setEditingId(null);
      setEditName('');
      showToast('Location renamed');
    },
    onError: (err: unknown) => showToast((err as { message?: string }).message ?? 'Failed to rename', 'error'),
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: number) => api.put<Location>(`/branches/${activeBranchId}/locations/${id}/set-default`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locations', activeBranchId] });
      showToast('Default location updated');
    },
    onError: (err: unknown) => showToast((err as { message?: string }).message ?? 'Failed to set default', 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/branches/${activeBranchId}/locations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locations', activeBranchId] });
      setDeleteConfirmId(null);
      showToast('Location deleted');
    },
    onError: (err: unknown) => {
      setDeleteConfirmId(null);
      showToast((err as { message?: string }).message ?? 'Cannot delete location', 'error');
    },
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Locations</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Stock areas within each branch</p>
        </div>
        {canWrite && activeBranchId && (
          <button type="button" onClick={() => { setShowCreateForm(v => !v); setNewName(''); }}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm">
            {showCreateForm ? 'Cancel' : '+ New Location'}
          </button>
        )}
      </div>

      {branches.length > 1 && (
        <div className="mb-4">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mr-2">Branch:</label>
          <select value={activeBranchId ?? ''} onChange={e => { setSelectedBranchId(Number(e.target.value)); setShowCreateForm(false); }}
            className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      )}

      {showCreateForm && canWrite && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4 mb-4 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-3">New Location</h2>
          <div className="flex gap-2">
            <input value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="e.g. Main Floor, Warehouse, Back Room" className={inputCls} autoFocus
              onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) createMutation.mutate(newName.trim()); }} />
            <button type="button" onClick={() => { if (newName.trim()) createMutation.mutate(newName.trim()); }}
              disabled={!newName.trim() || createMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors whitespace-nowrap">
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm py-8">
          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading locations...
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Default</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Created</th>
                {canWrite && <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {locations.map(loc => (
                <tr key={loc.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3">
                    {editingId === loc.id ? (
                      <div className="flex gap-2">
                        <input value={editName} onChange={e => setEditName(e.target.value)} className={inputCls} autoFocus
                          onKeyDown={e => {
                            if (e.key === 'Enter' && editName.trim()) renameMutation.mutate({ id: loc.id, name: editName.trim() });
                            if (e.key === 'Escape') { setEditingId(null); setEditName(''); }
                          }} />
                        <button type="button" onClick={() => { if (editName.trim()) renameMutation.mutate({ id: loc.id, name: editName.trim() }); }}
                          disabled={!editName.trim() || renameMutation.isPending}
                          className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-lg text-xs font-medium disabled:opacity-50 transition-colors">Save</button>
                        <button type="button" onClick={() => { setEditingId(null); setEditName(''); }}
                          className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-xs px-2 transition-colors">Cancel</button>
                      </div>
                    ) : (
                      <span className="font-medium text-gray-900 dark:text-white">{loc.name}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {loc.isDefaultFulfillment
                      ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-400">Default</span>
                      : <span className="text-xs text-gray-400 dark:text-gray-500">-</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                    {new Date(loc.createdAt).toLocaleDateString()}
                  </td>
                  {canWrite && (
                    <td className="px-4 py-3">
                      {deleteConfirmId === loc.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-red-600 dark:text-red-400">Delete?</span>
                          <button type="button" onClick={() => deleteMutation.mutate(loc.id)} disabled={deleteMutation.isPending}
                            className="text-xs bg-red-600 hover:bg-red-700 text-white px-2 py-0.5 rounded transition-colors disabled:opacity-50">Yes</button>
                          <button type="button" onClick={() => setDeleteConfirmId(null)}
                            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 transition-colors">No</button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          {editingId !== loc.id && (
                            <button type="button" title="Rename" onClick={() => { setEditingId(loc.id); setEditName(loc.name); }}
                              className="text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z" />
                              </svg>
                            </button>
                          )}
                          {!loc.isDefaultFulfillment && (
                            <button type="button" title="Set as default" onClick={() => setDefaultMutation.mutate(loc.id)}
                              disabled={setDefaultMutation.isPending}
                              className="text-gray-400 dark:text-gray-500 hover:text-green-600 dark:hover:text-green-400 transition-colors disabled:opacity-40">
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            </button>
                          )}
                          <button type="button" title="Delete" onClick={() => setDeleteConfirmId(loc.id)}
                            className="text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {locations.length === 0 && (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-8">No locations found for this branch</p>
          )}
        </div>
      )}
    </div>
  );
}