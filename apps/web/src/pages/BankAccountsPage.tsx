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
  hasMovements: boolean;
}

/** A bank movement the system recorded: a payment in, a refund or supplier payment out (#21). */
interface BankEntry {
  id: string;
  sourceType: string;
  amount: number;
  direction: 'in' | 'out';
  status: 'uncleared' | 'cleared';
  notes: string | null;
  createdAt: string;
}

/** A line of the bank's statement. */
interface StatementLine {
  id: string;
  statementDate: string;
  amount: number;
  direction: 'in' | 'out';
  reference: string | null;
  description: string | null;
  entryId: string | null;
}

interface StatementLineInput { statementDate: string; amount: number; direction: 'in' | 'out'; reference?: string; description?: string }

// ── Schemas ───────────────────────────────────────────────────────────────────

// Accounts are in ETB (owner decision 3a; foreign currency: #106).
const createSchema = z.object({
  accountName:   z.string().min(1, 'Required'),
  bankName:      z.string().min(1, 'Required'),
  accountNumber: z.string().min(4, 'At least 4 characters'),
  iban:          z.string().optional(),
});
type CreateForm = z.infer<typeof createSchema>;

/**
 * Statement lines pasted from the bank's export, one per line:
 * date (YYYY-MM-DD), amount, in|out, reference, description.
 */
export function parseStatement(text: string): StatementLineInput[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => {
      const [statementDate, amount, direction, reference, ...rest] = l.split(',').map((x) => x.trim());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(statementDate ?? '') || !(Number(amount) > 0) || (direction !== 'in' && direction !== 'out')) {
        throw new Error(`Cannot read: "${l}"`);
      }
      return {
        statementDate,
        amount: Number(amount),
        direction,
        ...(reference ? { reference } : {}),
        ...(rest.length ? { description: rest.join(', ') } : {}),
      };
    });
}

const inputCls = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-hidden focus:ring-2 focus:ring-blue-500 transition-colors';

// ── Main Component ────────────────────────────────────────────────────────────

export default function BankAccountsPage({ userRole }: { userRole?: string }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [selectedBranchId, setSelectedBranchId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);

  // The API's roles: Admin and Manager manage accounts; Finance_Officer too reconciles.
  const canWrite = ['Admin', 'Manager'].includes(userRole ?? '');
  const canReconcile = ['Admin', 'Manager', 'Finance_Officer'].includes(userRole ?? '');

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

  // ── Mutations ──────────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: (body: CreateForm) =>
      api.post<BankAccount>(`/branches/${selectedBranchId}/bank-accounts`, { ...body, iban: body.iban || undefined }),
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

  const setActiveMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      api.post(`/branches/${selectedBranchId}/bank-accounts/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: (_, { active }) => {
      queryClient.invalidateQueries({ queryKey: ['bank-accounts', selectedBranchId] });
      showToast(active ? 'Bank account reactivated' : 'Bank account deactivated');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      showToast(e.message ?? 'Failed to deactivate', 'error');
    },
  });

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: { accountName: '', bankName: '', accountNumber: '', iban: '' },
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
                className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4 mb-4 space-y-3 shadow-xs"
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
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-xs">
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
                          {canWrite && (
                            <button
                              onClick={() => setActiveMutation.mutate({ id: acct.id, active: !acct.isActive })}
                              disabled={setActiveMutation.isPending}
                              className={`${acct.isActive ? 'text-red-500 dark:text-red-400 hover:text-red-700' : 'text-green-600 dark:text-green-400 hover:text-green-800'} text-xs font-medium disabled:opacity-50 transition-colors`}
                            >
                              {acct.isActive ? 'Deactivate' : 'Reactivate'}
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

          {/* ── Reconciliation panel (owner decision 1a) ─────────────────── */}
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Reconciliation</h2>
            {!selectedAccountId ? (
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-8 text-center shadow-xs">
                <p className="text-sm text-gray-400 dark:text-gray-500">Select an account to reconcile its statement</p>
              </div>
            ) : (
              <Reconciliation branchId={selectedBranchId} accountId={selectedAccountId} canReconcile={canReconcile} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Reconciliation ────────────────────────────────────────────────────────────
// The bank's statement lines on one side, the system's open movements on the
// other; a line is matched to one movement and both are cleared (#21).

function Reconciliation({ branchId, accountId, canReconcile }: { branchId: number; accountId: number; canReconcile: boolean }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [statement, setStatement] = useState('');
  const [matching, setMatching] = useState<string | null>(null);
  const base = `/branches/${branchId}/bank-accounts/${accountId}`;

  const { data: lines } = useQuery({
    queryKey: ['bank-lines', accountId],
    queryFn: () => api.get<{ items: StatementLine[] }>(`${base}/statement-lines?pageSize=100`),
    enabled: !!getAccessToken(),
  });
  const { data: open } = useQuery({
    queryKey: ['bank-entries', accountId],
    queryFn: () => api.get<{ items: BankEntry[] }>(`${base}/entries?status=uncleared&pageSize=100`),
    enabled: !!getAccessToken(),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['bank-lines', accountId] });
    queryClient.invalidateQueries({ queryKey: ['bank-entries', accountId] });
  };
  const fail = (err: unknown) => showToast((err as { message?: string }).message ?? 'Failed', 'error');

  const importMutation = useMutation({
    mutationFn: (rows: StatementLineInput[]) =>
      api.post<{ imported: number; matched: number; duplicates: number }>(`${base}/statement-lines`, { lines: rows }),
    onSuccess: (r) => {
      refresh();
      setStatement('');
      showToast(`Imported ${r.imported} line(s), ${r.matched} matched${r.duplicates ? `, ${r.duplicates} already imported` : ''}`);
    },
    onError: fail,
  });
  const matchMutation = useMutation({
    mutationFn: ({ lineId, entryId }: { lineId: string; entryId: string }) => api.post(`${base}/statement-lines/${lineId}/match`, { entryId }),
    onSuccess: () => { refresh(); setMatching(null); showToast('Matched'); },
    onError: fail,
  });
  const unmatchMutation = useMutation({
    mutationFn: (lineId: string) => api.post(`${base}/statement-lines/${lineId}/unmatch`),
    onSuccess: () => { refresh(); showToast('Unmatched'); },
    onError: fail,
  });

  const submitImport = () => {
    try {
      importMutation.mutate(parseStatement(statement));
    } catch (err) {
      fail(err);
    }
  };
  const candidates = (l: StatementLine) => (open?.items ?? []).filter((e) => e.direction === l.direction && Math.abs(e.amount - l.amount) < 0.005);
  const sign = (d: 'in' | 'out') => (d === 'in' ? '↑ IN' : '↓ OUT');

  return (
    <div className="space-y-4">
      {canReconcile && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-3 shadow-xs space-y-2">
          <label htmlFor="statement" className="block text-xs font-medium text-gray-600 dark:text-gray-400">
            Import statement lines: date, amount, in/out, bank reference, description (one per line)
          </label>
          <textarea id="statement" value={statement} onChange={(e) => setStatement(e.target.value)} rows={3}
            placeholder="2026-10-11, 1500.00, in, FT26284XYZ, Transfer from customer" className={`${inputCls} font-mono text-xs`} />
          <button onClick={submitImport} disabled={!statement.trim() || importMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50">
            Import
          </button>
        </div>
      )}

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-xs">
        <h3 className="px-4 py-2 text-xs font-semibold text-gray-600 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">Statement lines</h3>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {(lines?.items ?? []).map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{l.statementDate}</td>
                <td className="px-4 py-2 font-medium text-gray-900 dark:text-white">{l.amount.toFixed(2)}</td>
                <td className="px-4 py-2 text-xs">{sign(l.direction)}</td>
                <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{l.reference ?? l.description ?? ''}</td>
                <td className="px-4 py-2 text-xs">
                  {l.entryId !== null ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded-sm bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-400">Matched</span>
                      {canReconcile && (
                        <button onClick={() => unmatchMutation.mutate(l.id)} className="text-gray-500 hover:text-red-600">Unmatch</button>
                      )}
                    </span>
                  ) : matching === l.id ? (
                    <select aria-label="Movement to match" defaultValue="" onChange={(e) => e.target.value && matchMutation.mutate({ lineId: l.id, entryId: e.target.value })}
                      className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-sm px-1 py-0.5 text-xs">
                      <option value="">{candidates(l).length ? 'Choose a movement…' : 'No open movement fits'}</option>
                      {candidates(l).map((e) => (
                        <option key={e.id} value={e.id}>{new Date(e.createdAt).toLocaleDateString()} · {e.notes ?? e.sourceType}</option>
                      ))}
                    </select>
                  ) : canReconcile ? (
                    <button onClick={() => setMatching(l.id)} className="text-blue-600 dark:text-blue-400 hover:text-blue-800">Match</button>
                  ) : (
                    <span className="text-amber-600">Open</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(lines?.items ?? []).length === 0 && <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-6">No statement lines imported</p>}
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-xs">
        <h3 className="px-4 py-2 text-xs font-semibold text-gray-600 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
          Open movements (not yet on a statement)
        </h3>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {(open?.items ?? []).map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{new Date(e.createdAt).toLocaleDateString()}</td>
                <td className="px-4 py-2 font-medium text-gray-900 dark:text-white">{e.amount.toFixed(2)}</td>
                <td className="px-4 py-2 text-xs">{sign(e.direction)}</td>
                <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{e.notes ?? e.sourceType}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(open?.items ?? []).length === 0 && <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-6">Every movement is matched</p>}
      </div>
    </div>
  );
}
