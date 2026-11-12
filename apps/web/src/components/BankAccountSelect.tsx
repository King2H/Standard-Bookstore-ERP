import { useState } from 'react';
import { SearchPicker } from '../shared/components/SearchPicker.js';
import type { PickerOption } from '../shared/picker.js';
import { bankAccountLabel, searchBranchAccounts, type BranchAccounts } from '../features/bankAccounts/queries.js';

/**
 * The account a bank payment goes to; shown only while the Bank Accounts
 * module is on (#21). Any of the branch's active accounts is found by typing
 * its name or bank (#266; was: a dropdown of the first 100).
 */
export default function BankAccountSelect({ accounts, value, onChange, className }: {
  accounts: BranchAccounts;
  value: number | null;
  onChange: (id: number | null) => void;
  className?: string;
}) {
  // The chosen account's label, kept as it was picked.
  const [chosen, setChosen] = useState<PickerOption | null>(null);
  if (accounts.branchId === null || accounts.total === 0) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-400">No active bank account in this branch. Add one under Bank Accounts.</p>
    );
  }
  const branchId = accounts.branchId;
  return (
    <SearchPicker
      aria-label="Bank account"
      value={value === null ? null : chosen?.id === value ? chosen : { id: value, label: '' }}
      onChange={(o) => { setChosen(o); onChange(o ? o.id : null); }}
      queryKey={`bank-accounts:${branchId}`}
      search={async (q, page) => {
        const found = await searchBranchAccounts(branchId, q, page);
        return { items: found.items.map((a) => ({ id: a.id, label: bankAccountLabel(a) })), total: found.total };
      }}
      placeholder="Type the account or bank…"
      className={className ?? 'w-full px-2.5 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500'}
    />
  );
}
