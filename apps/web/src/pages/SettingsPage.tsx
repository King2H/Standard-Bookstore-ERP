import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getAccessToken } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConfigRow {
  key: string;
  value: unknown;
  updatedBy: number;
  updatedAt: string;
  source?: 'branch' | 'system';
}

interface Branch { id: number; name: string; isActive: boolean }

// ── Config key metadata for display ──────────────────────────────────────────

const CONFIG_META: Record<string, { label: string; tab: string; type: 'string' | 'number' | 'boolean' | 'json'; description: string }> = {
  base_currency:                    { label: 'Base Currency',                tab: 'General',      type: 'string',  description: 'ISO 4217 code (e.g. USD)' },
  tax_rate:                         { label: 'Tax Rate',                     tab: 'General',      type: 'number',  description: 'Default tax rate (0–1, e.g. 0.10 = 10%)' },
  fiscal_year_start_month:          { label: 'Fiscal Year Start Month',      tab: 'General',      type: 'number',  description: 'Month number 1–12 (1 = January)' },
  max_line_discount_pct:            { label: 'Max Line Discount % (per role)',tab: 'Discounts',    type: 'json',    description: 'JSON object: {"Sales":10,"Manager":25,"Admin":50}' },
  max_transaction_discount_pct:     { label: 'Max Transaction Discount %',   tab: 'Discounts',    type: 'number',  description: 'Maximum total transaction discount allowed' },
  discount_approval_threshold_pct:  { label: 'Discount Approval Threshold %',tab: 'Discounts',    type: 'number',  description: 'Discount % requiring manager approval' },
  reorder_point_default:            { label: 'Reorder Point Default',        tab: 'Inventory',    type: 'number',  description: 'Default reorder threshold (units)' },
  allow_negative_stock:             { label: 'Allow Negative Stock',         tab: 'Inventory',    type: 'boolean', description: 'Allow stock to go below zero' },
  po_approval_threshold:            { label: 'PO Approval Threshold',        tab: 'Procurement',  type: 'number',  description: 'PO value (currency) requiring approval' },
  default_supplier_lead_time_days:  { label: 'Default Supplier Lead Time',   tab: 'Procurement',  type: 'number',  description: 'Fallback lead time in days' },
  return_window_days:               { label: 'Return Window (days)',         tab: 'Returns',      type: 'number',  description: 'Days within which returns are allowed' },
  max_return_value_without_auth:    { label: 'Max Return Value w/o Auth',    tab: 'Returns',      type: 'number',  description: 'Max refund amount without manager auth' },
  refund_method_after_window:       { label: 'Refund Method After Window',   tab: 'Returns',      type: 'string',  description: '"any" or "store_credit_only"' },
  min_deposit_pct:                  { label: 'Min Deposit %',                tab: 'Payments',     type: 'number',  description: 'Minimum deposit % for installment plans' },
  max_installments:                 { label: 'Max Installments',             tab: 'Payments',     type: 'number',  description: 'Maximum installments per plan' },
  installment_grace_period_days:    { label: 'Installment Grace Period',     tab: 'Payments',     type: 'number',  description: 'Days before overdue status is set' },
  loyalty_accrual_rate:             { label: 'Loyalty Accrual Rate',         tab: 'Loyalty',      type: 'number',  description: 'Points earned per currency unit (e.g. 0.01)' },
  loyalty_redemption_rate:          { label: 'Loyalty Redemption Rate',      tab: 'Loyalty',      type: 'number',  description: 'Currency value per point (e.g. 1.0)' },
  loyalty_min_transaction_amount:   { label: 'Loyalty Min Transaction',      tab: 'Loyalty',      type: 'number',  description: 'Min transaction amount to earn points' },
  exchange_cash_adjustment_allowed: { label: 'Exchange Cash Adjustment',     tab: 'Exchange',     type: 'boolean', description: 'Allow cash settlement on exchange orders' },
  notification_prefs:               { label: 'Notification Preferences',     tab: 'Notifications',type: 'json',    description: 'Per-event notification toggles (JSONB)' },
};

const TABS = ['General', 'Discounts', 'Inventory', 'Procurement', 'Returns', 'Payments', 'Loyalty', 'Exchange', 'Notifications'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatValue(value: unknown): string {
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value ?? '');
}

function parseInputValue(raw: string, type: string): unknown {
  if (type === 'number') return parseFloat(raw);
  if (type === 'boolean') return raw === 'true';
  if (type === 'json') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

// ── Inline editable config row ────────────────────────────────────────────────

function ConfigRowItem({
  row,
  isSuperAdmin,
  onSave,
}: {
  row: ConfigRow & { source?: 'branch' | 'system' };
  isSuperAdmin: boolean;
  onSave: (key: string, value: unknown) => void;
}) {
  const meta = CONFIG_META[row.key];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatValue(row.value));

  const handleSave = () => {
    const parsed = parseInputValue(draft, meta?.type ?? 'string');
    onSave(row.key, parsed);
    setEditing(false);
  };

  return (
    <div className="flex items-start gap-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-gray-900 dark:text-white">{meta?.label ?? row.key}</span>
          {row.source && (
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
              row.source === 'branch'
                ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
            }`}>
              {row.source === 'branch' ? 'branch override' : 'system default'}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-400 dark:text-gray-500">{meta?.description}</p>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {editing ? (
          <>
            {meta?.type === 'boolean' ? (
              <select
                value={draft}
                onChange={e => setDraft(e.target.value)}
                className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-24"
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : meta?.type === 'json' ? (
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                rows={3}
                className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-900 dark:text-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
              />
            ) : (
              <input
                type={meta?.type === 'number' ? 'number' : 'text'}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                step={meta?.type === 'number' ? 'any' : undefined}
                className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-36"
              />
            )}
            <button onClick={handleSave} className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">Save</button>
            <button onClick={() => { setEditing(false); setDraft(formatValue(row.value)); }} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">Cancel</button>
          </>
        ) : (
          <>
            <code className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-2 py-1 rounded font-mono max-w-[200px] truncate block">
              {formatValue(row.value)}
            </code>
            {isSuperAdmin && (
              <button
                onClick={() => { setDraft(formatValue(row.value)); setEditing(true); }}
                className="text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                title="Edit"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z" />
                </svg>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Branch override row (with delete) ────────────────────────────────────────

function BranchConfigRowItem({
  row,
  canEdit,
  onSave,
  onDelete,
}: {
  row: ConfigRow & { source: 'branch' | 'system' };
  canEdit: boolean;
  onSave: (key: string, value: unknown) => void;
  onDelete: (key: string) => void;
}) {
  const meta = CONFIG_META[row.key];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatValue(row.value));

  const handleSave = () => {
    onSave(row.key, parseInputValue(draft, meta?.type ?? 'string'));
    setEditing(false);
  };

  return (
    <div className="flex items-start gap-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-gray-900 dark:text-white">{meta?.label ?? row.key}</span>
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
            row.source === 'branch'
              ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
          }`}>
            {row.source === 'branch' ? 'branch override' : 'system default'}
          </span>
        </div>
        <p className="text-xs text-gray-400 dark:text-gray-500">{meta?.description}</p>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {editing ? (
          <>
            {meta?.type === 'boolean' ? (
              <select value={draft} onChange={e => setDraft(e.target.value)}
                className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-24">
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : meta?.type === 'json' ? (
              <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3}
                className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-900 dark:text-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 w-64" />
            ) : (
              <input type={meta?.type === 'number' ? 'number' : 'text'} value={draft}
                onChange={e => setDraft(e.target.value)} step={meta?.type === 'number' ? 'any' : undefined}
                className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-36" />
            )}
            <button onClick={handleSave} className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">Save</button>
            <button onClick={() => { setEditing(false); setDraft(formatValue(row.value)); }}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">Cancel</button>
          </>
        ) : (
          <>
            <code className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-2 py-1 rounded font-mono max-w-[200px] truncate block">
              {formatValue(row.value)}
            </code>
            {canEdit && (
              <>
                <button onClick={() => { setDraft(formatValue(row.value)); setEditing(true); }}
                  className="text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors" title="Override">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z" />
                  </svg>
                </button>
                {row.source === 'branch' && (
                  <button onClick={() => onDelete(row.key)}
                    className="text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 transition-colors" title="Remove override">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main Settings Page ────────────────────────────────────────────────────────

export default function SettingsPage({ userRole }: { userRole?: string }) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState('General');
  const [selectedBranchId, setSelectedBranchId] = useState<number | null>(null);

  const isSuperAdmin = userRole === 'Super_Admin';
  const canEditBranch = ['Super_Admin', 'Admin', 'Manager'].includes(userRole ?? '');

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: systemData, isLoading: sysLoading } = useQuery({
    queryKey: ['config-system'],
    queryFn: () => api.get<{ items: ConfigRow[] }>('/config/system'),
    enabled: !!getAccessToken(),
    staleTime: 30_000,
  });

  const { data: branchData } = useQuery({
    queryKey: ['branches'],
    queryFn: () => api.get<{ items: Branch[] }>('/branches'),
    enabled: !!getAccessToken(),
  });

  const branches = branchData?.items ?? [];

  const { data: branchConfigData, isLoading: branchConfigLoading } = useQuery({
    queryKey: ['config-branch', selectedBranchId],
    queryFn: () => api.get<{ items: Array<ConfigRow & { source: 'branch' | 'system' }> }>(`/config/branches/${selectedBranchId}`),
    enabled: !!getAccessToken() && selectedBranchId !== null,
    staleTime: 30_000,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────

  const updateSystemMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api.put(`/config/system/${key}`, { value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config-system'] });
      showToast('System config updated');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      showToast(e.message ?? 'Failed to update config', 'error');
    },
  });

  const updateBranchMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api.put(`/config/branches/${selectedBranchId}/${key}`, { value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config-branch', selectedBranchId] });
      showToast('Branch config updated');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      showToast(e.message ?? 'Failed to update branch config', 'error');
    },
  });

  const deleteBranchOverrideMutation = useMutation({
    mutationFn: (key: string) =>
      api.delete(`/config/branches/${selectedBranchId}/${key}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config-branch', selectedBranchId] });
      showToast('Branch override removed; system default restored');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      showToast(e.message ?? 'Failed to remove override', 'error');
    },
  });

  // ── Filter rows by active tab ──────────────────────────────────────────────

  const systemRows = (systemData?.items ?? []).filter(r => CONFIG_META[r.key]?.tab === activeTab);
  const branchRows = (branchConfigData?.items ?? []).filter(r => CONFIG_META[r.key]?.tab === activeTab);

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">System-wide and branch-level business rule configuration</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 flex-wrap border-b border-gray-200 dark:border-gray-700">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-2 text-sm font-medium rounded-t-lg transition-colors -mb-px ${
              activeTab === tab
                ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 bg-white dark:bg-gray-900'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ── System Defaults panel ─────────────────────────────────────────── */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">System Defaults</h2>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
              {isSuperAdmin ? 'Editable by Super_Admin only' : 'Read-only — contact Super_Admin to change'}
            </p>
          </div>
          <div className="px-5 py-2">
            {sysLoading ? (
              <p className="text-sm text-gray-400 dark:text-gray-500 py-4">Loading...</p>
            ) : systemRows.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-gray-500 py-4">No settings in this category</p>
            ) : (
              systemRows.map(row => (
                <ConfigRowItem
                  key={row.key}
                  row={row}
                  isSuperAdmin={isSuperAdmin}
                  onSave={(key, value) => updateSystemMutation.mutate({ key, value })}
                />
              ))
            )}
          </div>
        </div>

        {/* ── Branch Overrides panel ────────────────────────────────────────── */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Branch Overrides</h2>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Per-branch values take precedence over system defaults</p>
          </div>
          <div className="px-5 pt-3 pb-2">
            <select
              value={selectedBranchId ?? ''}
              onChange={e => setSelectedBranchId(e.target.value ? parseInt(e.target.value, 10) : null)}
              className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3 transition-colors"
            >
              <option value="">Select a branch...</option>
              {branches.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>

            {!selectedBranchId ? (
              <p className="text-sm text-gray-400 dark:text-gray-500 py-4 text-center">Select a branch to view its config</p>
            ) : branchConfigLoading ? (
              <p className="text-sm text-gray-400 dark:text-gray-500 py-4">Loading...</p>
            ) : branchRows.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-gray-500 py-4">No settings in this category</p>
            ) : (
              branchRows.map(row => (
                <BranchConfigRowItem
                  key={row.key}
                  row={row}
                  canEdit={canEditBranch}
                  onSave={(key, value) => updateBranchMutation.mutate({ key, value })}
                  onDelete={(key) => deleteBranchOverrideMutation.mutate(key)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
