import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';

export interface BankAccountOption {
  id: number;
  accountName: string;
  bankName: string;
  accountNumberMasked: string;
  currency: string;
}

/**
 * The branch's active bank accounts, for a bank payment (#21). With the Bank
 * Accounts module off the API has no such endpoint (404): then no account is
 * needed, and `required` is false.
 */
export function useBranchBankAccounts(branchId: number | null, enabled: boolean) {
  const query = useQuery({
    queryKey: ['bank-accounts', 'active', branchId],
    queryFn: () => api.get<{ items: BankAccountOption[] }>(`/branches/${branchId}/bank-accounts?isActive=true&pageSize=100`),
    enabled: enabled && branchId !== null,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  return { accounts: query.data?.items ?? [], required: query.isSuccess };
}

export function bankAccountLabel(a: BankAccountOption): string {
  return `${a.bankName} — ${a.accountName} (${a.accountNumberMasked})`;
}
