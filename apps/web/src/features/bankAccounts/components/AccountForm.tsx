import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CreateBankAccountRequestSchema, type BankAccount, type UpdateBankAccountRequest } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useCreateAccount, useUpdateAccount } from '../queries.js';

const INPUT = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-hidden focus:ring-2 focus:ring-blue-500 disabled:opacity-50 transition-colors';

const { accountName, bankName, accountNumber } = CreateBankAccountRequestSchema.shape;

type Values = { accountName: string; bankName: string; accountNumber: string; iban: string };

/**
 * Checked with the API's contract before sending (was: number and IBAN
 * unchecked). An empty IBAN means none; on an edit an empty number or IBAN
 * keeps the current one, which the page sees only masked.
 */
function formSchema(editing: boolean) {
  return z.object({ accountName, bankName, accountNumber: z.string(), iban: z.string() }).superRefine((v, ctx) => {
    for (const key of ['accountNumber', 'iban'] as const) {
      if (v[key].trim() === '' && (editing || key === 'iban')) continue;
      const checked = accountNumber.safeParse(v[key]);
      if (!checked.success) ctx.addIssue({ code: 'custom', path: [key], message: checked.error.issues[0].message });
    }
  });
}

/**
 * Opens a bank account or edits one (owner decision 1a). The names can always
 * change; the number and IBAN only while no money has moved through it.
 */
export function AccountForm({ branchId, account, onDone }: { branchId: number; account?: BankAccount; onDone: () => void }) {
  const { showToast } = useToast();
  const shopCurrency = useCurrency();
  const create = useCreateAccount(branchId);
  const update = useUpdateAccount(branchId);
  const fixed = !!account?.hasMovements;
  const { register, handleSubmit, formState: { errors } } = useForm<Values>({
    resolver: zodResolver(formSchema(!!account)),
    defaultValues: { accountName: account?.accountName ?? '', bankName: account?.bankName ?? '', accountNumber: '', iban: '' },
  });
  const busy = create.isPending || update.isPending;
  const fail = (e: Error) => showToast(e.message, 'error');

  const submit = handleSubmit((v) => {
    const number = v.accountNumber.trim();
    const ibanValue = v.iban.trim();
    if (!account) {
      create.mutate({ accountName: v.accountName.trim(), bankName: v.bankName.trim(), accountNumber: number, ...(ibanValue ? { iban: ibanValue } : {}) }, {
        onSuccess: () => { showToast('Bank account created'); onDone(); },
        onError: fail,
      });
      return;
    }
    const body: UpdateBankAccountRequest = { accountName: v.accountName.trim(), bankName: v.bankName.trim() };
    if (!fixed && number) body.accountNumber = number;
    if (!fixed && ibanValue) body.iban = ibanValue;
    update.mutate({ id: account.id, body }, { onSuccess: () => { showToast('Bank account updated'); onDone(); }, onError: fail });
  });

  const field = (name: keyof Values, label: string, placeholder: string, disabled = false) => (
    <div>
      <label htmlFor={`account-${name}`} className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{label}</label>
      <input id={`account-${name}`} {...register(name)} placeholder={placeholder} disabled={disabled}
        aria-invalid={errors[name] ? true : undefined} className={INPUT} />
      {errors[name] && <p role="alert" className="text-red-500 text-xs mt-1">{errors[name]?.message}</p>}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="account-form-title" onSubmit={submit} noValidate
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-md w-full mx-4 shadow-xl space-y-3">
        <h3 id="account-form-title" className="text-base font-semibold text-gray-900 dark:text-white">
          {account ? `Edit ${account.accountName}` : 'New Bank Account'}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          {field('accountName', 'Account Name *', 'e.g. Main Operations')}
          {field('bankName', 'Bank Name *', 'e.g. Commercial Bank of Ethiopia')}
          <div className="col-span-2">
            {field('accountNumber', account ? `Account Number (now ${account.accountNumberMasked})` : 'Account Number *',
              account ? 'Leave empty to keep it' : 'Account number', fixed)}
          </div>
          <div className="col-span-2">
            {field('iban', account ? `IBAN${account.ibanMasked ? ` (now ${account.ibanMasked})` : ''}` : 'IBAN (optional)',
              account ? 'Leave empty to keep it' : 'e.g. ET29NWBK60161331926819', fixed)}
          </div>
        </div>
        {fixed && <p className="text-xs text-gray-500 dark:text-gray-400">Money has moved through this account, so its number and IBAN stay as they are.</p>}
        <p className="text-xs text-gray-500 dark:text-gray-400">Accounts are in the shop's currency, {account?.currency ?? shopCurrency}.</p>
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onDone} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Back</button>
          <button type="submit" disabled={busy} className="px-4 py-2 text-sm rounded-lg text-white disabled:opacity-50 transition-colors bg-blue-600 hover:bg-blue-700">
            {account ? 'Save' : 'Create Account'}
          </button>
        </div>
      </form>
    </div>
  );
}
