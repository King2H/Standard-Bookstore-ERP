import { bankAccountLabel, type BankAccountOption } from '../features/bankAccounts/queries.js';

/** The account a bank payment goes to; shown only while the Bank Accounts module is on (#21). */
export default function BankAccountSelect({ accounts, value, onChange, className }: {
  accounts: BankAccountOption[];
  value: number | null;
  onChange: (id: number | null) => void;
  className?: string;
}) {
  if (accounts.length === 0) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-400">No active bank account in this branch. Add one under Bank Accounts.</p>
    );
  }
  return (
    <select
      aria-label="Bank account"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      className={className ?? 'w-full px-2.5 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500'}
    >
      <option value="">Select bank account…</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>{bankAccountLabel(a)}</option>
      ))}
    </select>
  );
}
