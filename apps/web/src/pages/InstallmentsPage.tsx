import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

type Role = string;
interface InstallmentsPageProps { userRole?: Role; }

interface Installment {
  id: string;
  planId: string;
  orderId: string;
  dueDate: string;
  amount: number;
  paidAmount: number;
  status: 'pending' | 'partial' | 'paid' | 'overdue';
  paidAt: string | null;
}

interface InstallmentPlan {
  id: string;
  orderId: string;
  totalAmount: number;
  depositAmount: number;
  numInstallments: number;
  currency: string;
  notes: string | null;
  createdAt: string;
  installments: Installment[];
}

const STATUS_COLORS: Record<string, string> = {
  pending:  'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  partial:  'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  paid:     'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  overdue:  'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
};

const canCreate = (r?: Role) => ['Sales', 'Manager', 'Admin', 'Finance_Officer'].includes(r ?? '');

type Tab = 'lookup' | 'new';

export default function InstallmentsPage({ userRole }: InstallmentsPageProps) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('lookup');

  // Lookup tab state
  const [lookupOrderId, setLookupOrderId] = useState('');
  const [lookedUpOrderId, setLookedUpOrderId] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');

  // New plan tab state
  const [newOrderId, setNewOrderId] = useState('');
  const [numInstallments, setNumInstallments] = useState('3');
  const [depositAmount, setDepositAmount] = useState('');
  const [firstDueDate, setFirstDueDate] = useState('');
  const [notes, setNotes] = useState('');

  // Fetch plan for looked-up order
  const { data: plan, isLoading: planLoading, error: planError } = useQuery<InstallmentPlan>({
    queryKey: ['installment-plan', lookedUpOrderId],
    queryFn: () => api.get(`/orders/${lookedUpOrderId}/installment-plan`),
    enabled: !!lookedUpOrderId,
    retry: false,
  });

  // Create plan mutation
  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<InstallmentPlan>(`/orders/${newOrderId}/installment-plan`, body),
    onSuccess: (p) => {
      showToast(`Installment plan created — ${p.numInstallments} installments`, 'success');
      setLookedUpOrderId(p.orderId);
      setLookupOrderId(p.orderId);
      setTab('lookup');
      setNewOrderId(''); setNumInstallments('3'); setDepositAmount(''); setFirstDueDate(''); setNotes('');
      qc.invalidateQueries({ queryKey: ['installment-plan', p.orderId] });
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // Pay installment mutation
  const payMut = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: number }) =>
      api.post<Installment>(`/installments/${id}/pay`, { amount }),
    onSuccess: () => {
      showToast('Payment recorded', 'success');
      setPayingId(null); setPayAmount('');
      qc.invalidateQueries({ queryKey: ['installment-plan', lookedUpOrderId] });
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  function handleLookup() {
    if (!lookupOrderId.trim()) return;
    setLookedUpOrderId(lookupOrderId.trim());
  }

  function handleCreatePlan() {
    if (!newOrderId.trim()) { showToast('Order ID is required', 'error'); return; }
    if (!numInstallments || parseInt(numInstallments) < 1) { showToast('Number of installments must be at least 1', 'error'); return; }
    createMut.mutate({
      numInstallments: parseInt(numInstallments),
      depositAmount: depositAmount ? parseFloat(depositAmount) : undefined,
      firstDueDate: firstDueDate || undefined,
      notes: notes || undefined,
    });
  }

  const totalPaid = plan?.installments.reduce((s, i) => s + i.paidAmount, 0) ?? 0;
  const totalRemaining = plan ? plan.totalAmount - totalPaid : 0;
  const allPaid = plan?.installments.every(i => i.status === 'paid') ?? false;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex-shrink-0">
        {(['lookup', 'new'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${tab === t ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {t === 'lookup' ? '📋 View Plan' : '+ New Plan'}
          </button>
        ))}
      </div>

      {/* ── Lookup / View Plan ── */}
      {tab === 'lookup' && (
        <div className="flex-1 overflow-auto p-4 pb-6 space-y-4 max-w-3xl mx-auto w-full">
          {/* Order lookup */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Look up by Order ID</h3>
            <div className="flex gap-2">
              <input
                value={lookupOrderId}
                onChange={e => setLookupOrderId(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLookup()}
                placeholder="Enter Order ID..."
                className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button onClick={handleLookup}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors">
                Load
              </button>
            </div>
          </div>

          {/* Plan display */}
          {planLoading && <div className="text-center text-gray-400 text-sm py-8">Loading...</div>}

          {planError && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 text-sm text-amber-700 dark:text-amber-300">
              No installment plan found for this order.
              {canCreate(userRole) && (
                <button onClick={() => { setNewOrderId(lookupOrderId); setTab('new'); }}
                  className="ml-2 underline hover:no-underline">Create one?</button>
              )}
            </div>
          )}

          {plan && (
            <div className="space-y-4">
              {/* Plan summary */}
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Plan Summary</h3>
                  {allPaid && <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">Fully Paid</span>}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Order', value: `#${plan.orderId}` },
                    { label: 'Total', value: `ETB ${plan.totalAmount.toFixed(2)}` },
                    { label: 'Deposit', value: `ETB ${plan.depositAmount.toFixed(2)}` },
                    { label: 'Installments', value: plan.numInstallments },
                  ].map(c => (
                    <div key={c.label} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2 text-center">
                      <p className="text-xs text-gray-500 dark:text-gray-400">{c.label}</p>
                      <p className="text-sm font-semibold text-gray-900 dark:text-white">{c.value}</p>
                    </div>
                  ))}
                </div>
                {/* Progress bar */}
                <div className="mt-3">
                  <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                    <span>Paid: ETB {totalPaid.toFixed(2)}</span>
                    <span>Remaining: ETB {totalRemaining.toFixed(2)}</span>
                  </div>
                  <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-2">
                    <div
                      className="bg-blue-500 h-2 rounded-full transition-all"
                      style={{ width: `${Math.min(100, (totalPaid / plan.totalAmount) * 100)}%` }}
                    />
                  </div>
                </div>
                {plan.notes && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 italic">{plan.notes}</p>}
              </div>

              {/* Installment schedule */}
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Payment Schedule</h3>
                </div>
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                  {plan.installments.map((inst, idx) => (
                    <div key={inst.id} className="px-4 py-3 flex items-center gap-3">
                      <div className="w-7 h-7 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-xs font-semibold text-gray-600 dark:text-gray-400 flex-shrink-0">
                        {idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-gray-900 dark:text-white">
                            ETB {inst.amount.toFixed(2)}
                          </span>
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[inst.status]}`}>
                            {inst.status}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          Due: {new Date(inst.dueDate).toLocaleDateString()}
                          {inst.paidAmount > 0 && inst.status !== 'paid' && ` · Paid: ETB ${inst.paidAmount.toFixed(2)}`}
                          {inst.paidAt && ` · Settled: ${new Date(inst.paidAt).toLocaleDateString()}`}
                        </p>
                      </div>
                      {/* Pay button */}
                      {inst.status !== 'paid' && canCreate(userRole) && (
                        payingId === inst.id ? (
                          <div className="flex gap-1 items-center" onClick={e => e.stopPropagation()}>
                            <input
                              type="number" min="0.01" step="0.01"
                              value={payAmount}
                              onChange={e => setPayAmount(e.target.value)}
                              placeholder={`Max ${(inst.amount - inst.paidAmount).toFixed(2)}`}
                              className="w-28 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <button
                              onClick={() => payMut.mutate({ id: inst.id, amount: parseFloat(payAmount) })}
                              disabled={payMut.isPending || !payAmount}
                              className="px-2 py-1 text-xs bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded transition-colors">
                              Pay
                            </button>
                            <button onClick={() => { setPayingId(null); setPayAmount(''); }}
                              className="text-xs text-gray-400 hover:text-gray-600 px-1">✕</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => { setPayingId(inst.id); setPayAmount((inst.amount - inst.paidAmount).toFixed(2)); }}
                            className="text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 px-2 py-1 rounded transition-colors whitespace-nowrap">
                            Record Payment
                          </button>
                        )
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── New Plan ── */}
      {tab === 'new' && canCreate(userRole) && (
        <div className="flex-1 overflow-auto p-4 pb-6 max-w-xl mx-auto w-full space-y-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Create Installment Plan</h3>

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Order ID *</label>
              <input value={newOrderId} onChange={e => setNewOrderId(e.target.value)} placeholder="Order ID (number)"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Number of Installments *</label>
              <input type="number" min="1" max="12" value={numInstallments} onChange={e => setNumInstallments(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Max allowed is set by system config (default: 12)</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Deposit Amount (ETB) — optional</label>
              <input type="number" min="0" step="0.01" value={depositAmount} onChange={e => setDepositAmount(e.target.value)}
                placeholder="Leave blank to use minimum from config"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">First Due Date — optional</label>
              <input type="date" value={firstDueDate} onChange={e => setFirstDueDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Defaults to 30 days from today</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Notes — optional</label>
              <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any notes..."
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <button onClick={handleCreatePlan} disabled={createMut.isPending || !newOrderId || !numInstallments}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors text-sm">
              {createMut.isPending ? 'Creating...' : 'Create Installment Plan'}
            </button>
          </div>
        </div>
      )}

      {tab === 'new' && !canCreate(userRole) && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-gray-400 text-sm">You don't have permission to create installment plans.</p>
        </div>
      )}
    </div>
  );
}
