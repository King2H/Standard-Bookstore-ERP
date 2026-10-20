import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateBankAccountRequest, ImportStatementRequest, UpdateBankAccountRequest } from '@bms/shared';
import { api } from '../../lib/api.js';
import {
  createAccount, importStatement, listAccounts, listEntries, listLines, matchLine, setAccountActive, unmatchLine, updateAccount,
  type EntriesParams, type LinesParams,
} from './api.js';

/**
 * Query keys for bank accounts. Every key starts with `bankAccountKeys.all`,
 * so a change to an account also refreshes the payment forms' account picker
 * (was: it kept a deactivated account for up to five minutes).
 */
export const bankAccountKeys = {
  all: ['bank-accounts'] as const,
  active: (branchId: number | null) => [...bankAccountKeys.all, 'active', branchId] as const,
  list: (branchId: number, page: number, pageSize: number) => [...bankAccountKeys.all, 'list', branchId, page, pageSize] as const,
  entries: (accountId: number, params: EntriesParams) => [...bankAccountKeys.all, 'entries', accountId, params] as const,
  lines: (accountId: number, params: LinesParams) => [...bankAccountKeys.all, 'lines', accountId, params] as const,
};

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
    queryKey: bankAccountKeys.active(branchId),
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

/** The branch's accounts; a 404 means the module is off, so it is not retried. */
export function useAccounts(branchId: number, page: number, pageSize: number) {
  return useQuery({
    queryKey: bankAccountKeys.list(branchId, page, pageSize), queryFn: () => listAccounts(branchId, { page, pageSize }),
    placeholderData: keepPreviousData, retry: false,
  });
}

export function useEntries(branchId: number, accountId: number, params: EntriesParams, enabled = true) {
  return useQuery({
    queryKey: bankAccountKeys.entries(accountId, params), queryFn: () => listEntries(branchId, accountId, params),
    placeholderData: keepPreviousData, enabled,
  });
}

export function useLines(branchId: number, accountId: number, params: LinesParams) {
  return useQuery({
    queryKey: bankAccountKeys.lines(accountId, params), queryFn: () => listLines(branchId, accountId, params),
    placeholderData: keepPreviousData,
  });
}

function useBankStep<A, R>(mutationFn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: bankAccountKeys.all }) });
}

export const useCreateAccount = (branchId: number) =>
  useBankStep((body: Omit<CreateBankAccountRequest, 'currency'>) => createAccount(branchId, body));
export const useUpdateAccount = (branchId: number) =>
  useBankStep(({ id, body }: { id: number; body: UpdateBankAccountRequest }) => updateAccount(branchId, id, body));
export const useSetAccountActive = (branchId: number) =>
  useBankStep(({ id, active }: { id: number; active: boolean }) => setAccountActive(branchId, id, active));
export const useImportStatement = (branchId: number, accountId: number) =>
  useBankStep((body: ImportStatementRequest) => importStatement(branchId, accountId, body));
export const useMatchLine = (branchId: number, accountId: number) =>
  useBankStep(({ lineId, entryId }: { lineId: string; entryId: string }) => matchLine(branchId, accountId, lineId, entryId));
export const useUnmatchLine = (branchId: number, accountId: number) =>
  useBankStep((lineId: string) => unmatchLine(branchId, accountId, lineId));
