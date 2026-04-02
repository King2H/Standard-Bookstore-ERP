import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, getAccessToken } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Branch { id: number; name: string; isActive: boolean }

interface BankAccount {
  id: number;
  branchId: number;
  accountName: string;
  bankName: string;
  accountNumberMasked: string;
  ibanMasked: string | null;
  currency: string;
  isActive: boolean;
  createdAt: string;
}

interface ReconciliationEntry {
  id: number;
  bankAccountId: number;
  paymentRefId: number | null;
  refundRefId: number | null;
  amount: string;
  direction: 'in' | 'out';
  status: 'uncleared' | 'cleared' | 'unmatched';
  statementDate: string | null;
  notes: string | null;
  createdAt: string;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const createSchema = z.object({
  accountName:   z.string().min(1, 'Required'),
  bankName:      z.string().min(1, 'Required'),
  accountNumber: z.string().min(1, 'Required'),
  iban:          z.string().optional(),
  currency:      z.string().length(3, 'Must be 3-letter ISO code').toUpperCase(),
});
type CreateForm = z.infer<typeof createSchema>;

const inputCls = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors';

const STATUS_COLORS: Record<string, string> = {
  uncleared: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-800 dark:text-yellow-300',
  cleared:   'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-400',
  unmatched: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-400',
};

// ── Main Component ────────────────────────────────────────────────────────────

export default function BankAccountsPage({ userRole }: { userRole?: string }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [selectedBranchId, setSelectedBranchId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [reconPage, setReconPage] = useState(1);
  const [reconStatusFilter, setReconStatusFilter] = useState('');

  const canWrite = ['Super_Admin', 'Admin', 'Manager'].includes(userRole ?? '');
  const canReconcile = ['Super_Admin', 'Admin', 'Manager', 'Finance_Officer'].includes(userRole ?? '');

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: branchData } = useQuery({
    queryKey: ['branches'],
    queryFn: () => api.get<{ items: Branch[] }>('/branches'),
    enabled: !!getAccessToken(),
  });
  const branches = branchData?.items.filter(b => b.isActive) ?? [];

  const { data: accountsData, isLoading: accountsLoading } = useQuery({
    queryKey: ['bank-accounts', selectedBranchId],
    queryFn: () => api.get<{ items: BankAccount[]; total: number }>(
      `/branches/${selectedBranchId}/bank-accounts`,
    ),
    enabled: !!getAccessToken() && selectedBranchId !== null,
  });

  const { data: reconData, isLoading: reconLoading } = useQuery({
    queryKey: ['reconciliation', selectedAccountId, reconPage, reconStatusFilter],
    queryFn: () => {
      const params = new URLSearchParams({
        bankAccountId: String(selectedAccountId),
        page: String(reconPage),
        pageSize: '20',
      });
      if (reconStatusFilter) params.set('status', reconStatusFilter);
      return api.get<{ items: ReconciliationEntry[]; total: number; totalPages: number }>(
        `/branches/${selectedBranchId}/reconciliation?${params}`,
      );
    },
    enabled: !!getAccessToken() && selectedAccountId !== null && selectedBranchId !== null,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: (body: CreateForm) =>
      api.post<BankAccount>(`/branches/${selectedBranchId}/bank-accounts`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bank-accounts', selectedBranchId] });
      setShowForm(false); reset(); setApiError(null);
      showToast('Bank account created');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      setApiError(e.message ?? 'Failed to create bank account');
      showToast(e.message ?? 'Failed to create bank account', 'error');
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: number) =>
      api.post(`/branches/${selectedBranchId}/bank-accounts/${id}/deactivate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bank-accounts', selectedBranchId] });
      showToast('Bank account deactivated');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      showToast(e.message ?? 'Failed to deactivate', 'error');
    },
  });

  const clearMutation = useMutation({
    mutationFn: ({ entryId, paymentRefId }: { entryId: number; paymentRefId: number | null }) =>
      api.put(`/branches/${selectedBranchId}/reconciliation/${entryId}`, { paymentRefId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reconciliation', selectedAccountId] });
      showToast('Entry cleared');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      showToast(e.message ?? 'Failed to clear entry', 'error');
    },
  });

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: { accountName: '', bankName: '', accountNumber: '', iban: '', currency: 'USD' },
  });

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Bank Accounts</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Manage branch bank accounts and reconciliation
          </p>
        </div>
      </div>

      {/* Branch selector */}
      <div className="mb-6">
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Branch</label>
        <select
          value={selectedBranchId ?? ''}
          onChange={e => {
            setSelectedBranchId(e.target.value ? parseInt(e.target.value, 10) : null);
            setSelectedAccountId(null);
            setShowForm(false);
          }}
          className={`${inputCls} max-w-xs`}
        >
          <option value="">Select a branch...</option>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      {!selectedBranchId ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">Select a branch to view its bank accounts.</p>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

          {/* ── Bank Accounts panel ─────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Accounts</h2>
              {canWrite && (
                <button
                  onClick={() => { setShowForm(!showForm); setApiError(null); }}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                >
                  {showForm ? 'Cancel' : '+ New Account'}
                </button>
              )}
            </div>

            {/* Create form */}
            {showForm && (
              <form
                onSubmit={handleSubmit(data => { setApiError(null); createMutation.mutate(data); })}
                className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4 mb-4 space-y-3 shadow-sm"
              >
                {apiError && (
                  <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 text-sm text-red-700 dark:text-red-400">
                    {apiError}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Account Name *</label>
                    <input {...register('accountName')} placeholder="e.g. Main Operations" className={inputCls} />
                    {errors.accountName && <p className="text-red-500 text-xs mt-1">{errors.accountName.message}</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Bank Name *</label>
                    <input {...register('bankName')} placeholder="e.g. First National Bank" className={inputCls} />
                    {errors.bankName && <p className="text-red-500 text-xs mt-1">{errors.bankName.message}</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Account Number *</label>
                    <input {...register('accountNumber')} placeholder="Account number" className={inputCls} />
                    {errors.accountNumber && <p className="text-red-500 text-xs mt-1">{errors.accountNumber.message}</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Currency *</label>
                    <input {...register('currency')} placeholder="USD" maxLength={3} className={inputCls} />
                    {errors.currency && <p className="text-red-500 text-xs mt-1">{errors.currency.message}</p>}
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">IBAN (optional)</label>
                    <input {...register('iban')} placeholder="e.g. GB29NWBK60161331926819" className={inputCls} />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={createMutation.isPending || isSubmitting}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                  >
                    {createMutation.isPending ? 'Creating...' : 'Create Account'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowForm(false); reset(); setApiError(null); }}
                    className="bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {/* Accounts table */}
            {accountsLoading ? (
              <p className="text-sm text-gray-400 dark:text-gray-500">Loading...</p>
            ) : (
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Account</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Number</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Currency</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Status</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                    {accountsData?.items.map(acct => (
                      <tr
                        key={acct.id}
                        onClick={() => setSelectedAccountId(acct.id === selectedAccountId ? null : acct.id)}
                        className={`cursor-pointer transition-colors ${
                          selectedAccountId === acct.id
                            ? 'bg-blue-50 dark:bg-blue-950/30'
                            : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                        }`}
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900 dark:text-white">{acct.accountName}</div>
                          <div className="text-xs text-gray-400 dark:text-gray-500">{acct.bankName}</div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">
                          {acct.accountNumberMasked}
                          {acct.ibanMasked && <div className="text-gray-400 dark:text-gray-500">{acct.ibanMasked}</div>}
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{acct.currency}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            acct.isActive
                              ? 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-400'
                              : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                          }`}>
                            {acct.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          {canWrite && acct.isActive && (
                            <button
                              onClick={() => deactivateMutation.mutate(acct.id)}
                              disabled={deactivateMutation.isPending}
                              className="text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 text-xs font-medium disabled:opacity-50 transition-colors"
                            >
                              Deactivate
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(!accountsData?.items || accountsData.items.length === 0) && (
                  <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-8">No bank accounts found</p>
                )}
              </div>
            )}
          </div>

          {/* ── Reconciliation panel ────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
                Reconciliation
                {selectedAccountId && (
                  <span className="ml-2 text-xs font-normal text-gray-400 dark:text-gray-500">
                    — Account #{selectedAccountId}
                  </span>
                )}
              </h2>
              <select
                value={reconStatusFilter}
                onChange={e => { setReconStatusFilter(e.target.value); setReconPage(1); }}
                className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">All statuses</option>
                <option value="uncleared">Uncleared</option>
                <option value="cleared">Cleared</option>
                <option value="unmatched">Unmatched</option>
              </select>
            </div>

            {!selectedAccountId ? (
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-8 text-center shadow-sm">
                <p className="text-sm text-gray-400 dark:text-gray-500">Select an account to view reconciliation entries</p>
              </div>
            ) : reconLoading ? (
              <p className="text-sm text-gray-400 dark:text-gray-500">Loading...</p>
            ) : (
              <>
                <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-sm">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
                      <tr>
                        <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Date</th>
                        <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Amount</th>
                        <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Dir</th>
                        <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Status</th>
                        {canReconcile && (
                          <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Action</th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {reconData?.items.map(entry => (
                        <tr key={entry.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                          <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                            {entry.statementDate ?? new Date(entry.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                            {parseFloat(entry.amount).toFixed(2)}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-xs font-medium ${
                              entry.direction === 'in'
                                ? 'text-green-600 dark:text-green-400'
                                : 'text-red-600 dark:text-red-400'
                            }`}>
                              {entry.direction === 'in' ? '↑ IN' : '↓ OUT'}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[entry.status]}`}>
                              {entry.status}
                            </span>
                          </td>
                          {canReconcile && (
                            <td className="px-4 py-3">
                              {entry.status !== 'cleared' && (
                                <button
                                  onClick={() => clearMutation.mutate({ entryId: entry.id, paymentRefId: null })}
                                  disabled={clearMutation.isPending}
                                  className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-40 transition-colors"
                                >
                                  Clear
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {(!reconData?.items || reconData.items.length === 0) && (
                    <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-8">No reconciliation entries</p>
                  )}
                </div>

                {/* Pagination */}
                {reconData && reconData.totalPages > 1 && (
                  <div className="flex items-center justify-between mt-3">
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Page {reconPage} of {reconData.totalPages}
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setReconPage(p => Math.max(1, p - 1))}
                        disabled={reconPage === 1}
                        className="px-3 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 transition-colors"
                      >
                        Previous
                      </button>
                      <button
                        onClick={() => setReconPage(p => Math.min(reconData.totalPages, p + 1))}
                        disabled={reconPage === reconData.totalPages}
                        className="px-3 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 transition-colors"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
