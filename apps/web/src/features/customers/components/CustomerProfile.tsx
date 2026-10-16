import { useState } from 'react';
import type { Customer, ReceivableSourceType, ReceivableStatus } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import Pagination, { makePageSizeHandler } from '../../../components/Pagination.js';
import { StatusBadge } from '../../../components/StatusFilter.js';
import { useMyProfile } from '../../account/queries.js';
import type { HistoryPage } from '../api.js';
import {
  useAdjustStoreCredit, useCustomer, useCustomerReceivables, useLoyaltyHistory, useRedeemPoints, useStoreCreditHistory,
  useUpdateCustomer,
} from '../queries.js';
import { canChangeCustomerStatus, canCorrectBalances, canEditCustomers, canSeeReceivables } from '../rules.js';
import { CustomerForm } from './CustomerForm.js';
import { StatusActions } from './StatusActions.js';

type ProfileTab = 'profile' | 'loyalty' | 'store-credit' | 'receivables';
const TAB_LABEL: Record<ProfileTab, string> = { profile: 'Profile', loyalty: 'Loyalty', 'store-credit': 'Store Credit', receivables: 'Receivables' };

const SOURCE_LABELS: Record<ReceivableSourceType, string> = {
  pos_credit_sale: 'POS Credit Sale',
  order_credit_sale: 'Order Credit Sale',
  exchange_difference: 'Exchange Diff.',
};
const REF_TYPE_LABELS: Record<string, string> = {
  pos_credit_sale: '🛒 POS Credit Sale',
  pos_credit_settlement: '✅ POS Settlement',
  transaction: '💳 Store Credit Used',
  exchange_refund: '🔁 Exchange Refund',
  exchange_payment: '🔁 Exchange Payment',
  manual: '✏️ Manual Adjustment',
};
const STATUS_STYLE: Record<ReceivableStatus, string> = {
  Pending: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  PartiallyPaid: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
  Settled: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  WrittenOff: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  Cancelled: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  Overdue: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};
const STATUS_LABEL: Partial<Record<ReceivableStatus, string>> = { PartiallyPaid: 'Partial', WrittenOff: 'Written off' };

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const LABEL = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';
const CARD = 'bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800';
const HISTORY_PAGE_SIZE = 25;
const AMOUNT = /^\d+(\.\d{1,2})?$/;

/** A page of history, with its own paging (was: the newest 25 only). */
function useHistoryPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(HISTORY_PAGE_SIZE);
  const current: HistoryPage = { page, pageSize };
  return { current, setPage, onPageSizeChange: makePageSizeHandler(setPage, setPageSize) };
}

function HistoryPanel({ title, empty, loading, rows, columns, total, totalPages, paging, itemLabel, children }: {
  title: string; empty: string; loading: boolean; rows: number; columns: string[]; total: number; totalPages: number;
  paging: ReturnType<typeof useHistoryPage>; itemLabel: string; children: React.ReactNode;
}) {
  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
      </div>
      {loading ? (
        <div className="p-6 text-center text-gray-400 text-sm">Loading...</div>
      ) : rows === 0 ? (
        <div className="p-6 text-center text-gray-400 text-sm">{empty}</div>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800"><tr>
              {columns.map(h => <th key={h} className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">{children}</tbody>
          </table>
          {totalPages > 1 && (
            <Pagination page={paging.current.page} pageSize={paging.current.pageSize} total={total} totalPages={totalPages}
              onPageChange={paging.setPage} onPageSizeChange={paging.onPageSizeChange} itemLabel={itemLabel} pageSizeOptions={[25, 50, 100]} />
          )}
        </>
      )}
    </div>
  );
}

function LoyaltyTab({ c, canCorrect }: { c: Customer; canCorrect: boolean }) {
  const { showToast } = useToast();
  const paging = useHistoryPage();
  const { data: history } = useLoyaltyHistory(c.id, paging.current, true);
  const redeem = useRedeemPoints();
  const [points, setPoints] = useState('');
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const validPoints = /^[1-9]\d*$/.test(points);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className={`${CARD} p-6 text-center`}>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Points Balance</p>
          <p className="text-3xl font-bold text-blue-600 dark:text-blue-400">{c.loyaltyBalance.toFixed(0)}</p>
        </div>
        <div className={`${CARD} p-6 text-center`}>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Lifetime Earned</p>
          <p className="text-3xl font-bold text-green-600 dark:text-green-400">{c.lifetimePoints.toFixed(0)}</p>
        </div>
      </div>

      {canCorrect && (
        <div className={`${CARD} p-6`}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Redeem Points</h3>
          <div className="flex gap-3 items-end">
            <div className="flex-1"><label htmlFor="redeem-points" className={LABEL}>Points</label>
              <input id="redeem-points" type="number" min="1" step="1" value={points} onChange={e => setPoints(e.target.value)} className={INPUT} /></div>
            <div className="flex-1"><label htmlFor="redeem-ref" className={LABEL}>Transaction Ref</label>
              <input id="redeem-ref" value={ref} onChange={e => setRef(e.target.value)} className={INPUT} /></div>
            <div className="flex-1"><label htmlFor="redeem-reason" className={LABEL}>Reason *</label>
              <input id="redeem-reason" value={reason} onChange={e => setReason(e.target.value)} placeholder="Why are points taken off?" className={INPUT} /></div>
            <button type="button" disabled={!validPoints || !reason.trim() || redeem.isPending}
              onClick={() => redeem.mutate({ id: c.id, body: { points: Number(points), transactionRef: ref.trim() || null, reason: reason.trim() } }, {
                onSuccess: () => { setPoints(''); setRef(''); setReason(''); showToast('Points redeemed', 'success'); },
                onError: (e: Error) => showToast(e.message, 'error'),
              })}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              {redeem.isPending ? 'Redeeming...' : 'Redeem'}
            </button>
          </div>
        </div>
      )}

      <HistoryPanel title="Loyalty History" empty="No history yet." loading={!history} rows={history?.items.length ?? 0}
        columns={['Date', 'Delta', 'Reason', 'Ref']} total={history?.total ?? 0} totalPages={history?.totalPages ?? 0} paging={paging} itemLabel="entry" >
        {history?.items.map(h => (
          <tr key={h.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
            <td className="px-4 py-2 text-gray-600 dark:text-gray-400 text-xs">{new Date(h.createdAt).toLocaleDateString()}</td>
            <td className={`px-4 py-2 font-medium ${h.pointsDelta >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {h.pointsDelta >= 0 ? '+' : ''}{h.pointsDelta}
            </td>
            <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{h.reason}</td>
            <td className="px-4 py-2 text-gray-500 dark:text-gray-500 text-xs">{h.transactionRef ?? '—'}</td>
          </tr>
        ))}
      </HistoryPanel>
    </div>
  );
}

function StoreCreditTab({ c, canCorrect, currency }: { c: Customer; canCorrect: boolean; currency: string }) {
  const { showToast } = useToast();
  const paging = useHistoryPage();
  const { data: history } = useStoreCreditHistory(c.id, paging.current, true);
  const adjust = useAdjustStoreCredit();
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [refId, setRefId] = useState('');
  const [reason, setReason] = useState('');
  const validAmount = AMOUNT.test(amount.trim()) && Number(amount) > 0;
  const owes = c.outstandingReceivables > 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className={`${CARD} p-6 text-center`}>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Pre-paid Store Credit</p>
          <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">{currency} {c.storeCreditBalance.toFixed(2)}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Available to spend</p>
        </div>
        {/* What the customer owes across every unsettled receivable: order, POS and exchange alike. */}
        <div className={`bg-white dark:bg-gray-900 rounded-xl border p-6 text-center ${owes ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20' : 'border-gray-200 dark:border-gray-800'}`}>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Outstanding Balance</p>
          <p className={`text-3xl font-bold ${owes ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}`}>
            {currency} {c.outstandingReceivables.toFixed(2)}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{owes ? '⚠️ Amount owed to store' : '✓ No outstanding debt'}</p>
        </div>
      </div>

      {canCorrect && (
        <div className={`${CARD} p-6`}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Manual Adjustment</h3>
          <div className="grid grid-cols-2 gap-3">
            <div><label htmlFor="credit-amount" className={LABEL}>Amount</label>
              <input id="credit-amount" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className={INPUT} /></div>
            <div><label htmlFor="credit-direction" className={LABEL}>Direction</label>
              <select id="credit-direction" value={direction} onChange={e => setDirection(e.target.value as 'credit' | 'debit')} className={INPUT}>
                <option value="credit">Credit (Add)</option>
                <option value="debit">Debit (Subtract)</option>
              </select></div>
            {/* Recorded as a manual adjustment; the reference is a note such as a receipt number (owner decision 2a). */}
            <div className="col-span-2"><label htmlFor="credit-ref" className={LABEL}>Reference</label>
              <input id="credit-ref" value={refId} onChange={e => setRefId(e.target.value)} placeholder="e.g. a receipt number" className={INPUT} /></div>
            <div className="col-span-2"><label htmlFor="credit-reason" className={LABEL}>Reason *</label>
              <input id="credit-reason" value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is the balance changed?" className={INPUT} /></div>
          </div>
          <button type="button" disabled={!validAmount || !reason.trim() || adjust.isPending}
            onClick={() => adjust.mutate({ id: c.id, body: { amount: amount.trim(), direction, refId: refId.trim() || null, reason: reason.trim() } }, {
              onSuccess: () => { setAmount(''); setRefId(''); setReason(''); showToast('Store credit adjusted', 'success'); },
              onError: (e: Error) => showToast(e.message, 'error'),
            })}
            className="mt-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
            {adjust.isPending ? 'Applying...' : 'Apply Adjustment'}
          </button>
        </div>
      )}

      <HistoryPanel title="Store Credit History" empty="No history yet." loading={!history} rows={history?.items.length ?? 0}
        columns={['Date', 'Amount', 'Direction', 'Ref Type', 'Ref ID']} total={history?.total ?? 0} totalPages={history?.totalPages ?? 0} paging={paging} itemLabel="entry">
        {history?.items.map(h => (
          <tr key={h.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
            <td className="px-4 py-2 text-gray-600 dark:text-gray-400 text-xs">{new Date(h.createdAt).toLocaleDateString()}</td>
            <td className="px-4 py-2 font-medium text-gray-900 dark:text-white">{currency} {h.amount.toFixed(2)}</td>
            <td className="px-4 py-2">
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${h.direction === 'credit' ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>
                {h.direction === 'credit' ? '+ Credit' : '− Debit'}
              </span>
            </td>
            <td className="px-4 py-2 text-gray-500 dark:text-gray-500 text-xs">{(h.refType && REF_TYPE_LABELS[h.refType]) ?? h.refType ?? '—'}</td>
            <td className="px-4 py-2 text-gray-500 dark:text-gray-500 text-xs font-mono">{h.refId ?? '—'}</td>
          </tr>
        ))}
      </HistoryPanel>
    </div>
  );
}

function ReceivablesTab({ c, currency }: { c: Customer; currency: string }) {
  const paging = useHistoryPage();
  const { data, isLoading } = useCustomerReceivables(c.id, paging.current, true);
  return (
    <div className="space-y-4">
      {/* Every receivable of the customer, settled ones too (was titled "Outstanding Receivables"). */}
      <HistoryPanel title="Receivables" empty="No receivables yet." loading={isLoading} rows={data?.items.length ?? 0}
        columns={['Date', 'Type', 'Reference', 'Original Amount', 'Outstanding Amount', 'Due Date', 'Status']}
        total={data?.total ?? 0} totalPages={data?.totalPages ?? 0} paging={paging} itemLabel="receivable">
        {data?.items.map(r => (
          <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
            <td className="px-4 py-2 text-gray-600 dark:text-gray-400 text-xs">{new Date(r.createdAt).toLocaleDateString()}</td>
            <td className="px-4 py-2">
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">{SOURCE_LABELS[r.sourceType] ?? r.sourceType}</span>
            </td>
            <td className="px-4 py-2 text-gray-500 dark:text-gray-500 text-xs font-mono">{r.sourceRefId}</td>
            <td className="px-4 py-2 text-gray-900 dark:text-white">{currency} {r.originalAmount.toFixed(2)}</td>
            <td className="px-4 py-2 font-semibold">
              <span className={r.outstandingAmount > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}>{currency} {r.outstandingAmount.toFixed(2)}</span>
            </td>
            <td className="px-4 py-2">
              <span className={r.status === 'Overdue' ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-600 dark:text-gray-400'}>
                {r.dueDate ? new Date(r.dueDate).toLocaleDateString() : '—'}
              </span>
            </td>
            <td className="px-4 py-2">
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
            </td>
          </tr>
        ))}
      </HistoryPanel>
    </div>
  );
}

/** A customer's profile: details, loyalty, store credit and, for the roles that take payments, receivables. */
export function CustomerProfile({ customer, onBack }: { customer: Customer; onBack: () => void }) {
  const { showToast } = useToast();
  const currency = useCurrency();
  const { data: me } = useMyProfile();
  // Read again after every change, so the status and balances shown are current (was: kept from the list).
  const c = useCustomer(customer.id).data ?? customer;
  const update = useUpdateCustomer();
  const canEdit = canEditCustomers(me);
  const tabs: ProfileTab[] = ['profile', 'loyalty', 'store-credit', ...(canSeeReceivables(me) ? ['receivables' as const] : [])];
  const [tab, setTab] = useState<ProfileTab>('profile');

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-4">
        <button type="button" onClick={onBack} className="text-sm text-blue-600 hover:underline">← Back to List</button>
        <span className="font-mono text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-2 py-1 rounded-sm">{c.customerCode}</span>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{c.fullName}</h2>
        <StatusBadge status={c.status} />
        {canChangeCustomerStatus(me) && <div className="ml-auto flex gap-2"><StatusActions customer={c} /></div>}
      </div>

      {c.groups.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {c.groups.map(g => (
            <span key={g.id} className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 px-2 py-0.5 rounded-full">
              {g.name} {g.discountPct > 0 ? `(${g.discountPct}% off)` : ''}
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {tabs.map(t => (
          <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${tab === t ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <div className={`${CARD} p-6`}>
          <CustomerForm customer={c} disabled={!canEdit} className="space-y-4"
            onSubmit={(body) => update.mutate({ id: c.id, body }, {
              onSuccess: () => showToast('Customer updated', 'success'),
              onError: (e: Error) => showToast(e.message, 'error'),
            })}>
            {canEdit && (
              <button type="submit" disabled={update.isPending} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-6 py-2 rounded-lg transition-colors">
                {update.isPending ? 'Saving...' : 'Save Changes'}
              </button>
            )}
          </CustomerForm>
        </div>
      )}
      {tab === 'loyalty' && <LoyaltyTab c={c} canCorrect={canCorrectBalances(me)} />}
      {tab === 'store-credit' && <StoreCreditTab c={c} canCorrect={canCorrectBalances(me)} currency={currency} />}
      {tab === 'receivables' && <ReceivablesTab c={c} currency={currency} />}
    </div>
  );
}
