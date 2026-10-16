import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdjustStoreCreditRequest, CreateCustomerRequest, RedeemPointsRequest, UpdateCustomerRequest } from '@bms/shared';
import {
  adjustStoreCredit, createCustomer, getCustomer, getCustomerReceivables, getLoyaltyHistory, getStoreCreditHistory,
  listCustomers, redeemPoints, runCustomerAction, updateCustomer,
  type CustomerAction, type CustomerListParams, type HistoryPage,
} from './api.js';

/**
 * Query keys for customer data. Every key starts with `customerKeys.all`, so
 * a change refreshes the list, the profile and its history together (was:
 * the list kept the old balances after a correction).
 */
export const customerKeys = {
  all: ['customers'] as const,
  lists: () => [...customerKeys.all, 'list'] as const,
  list: (params: CustomerListParams) => [...customerKeys.lists(), params] as const,
  detail: (id: number) => [...customerKeys.all, 'detail', id] as const,
  loyalty: (id: number, page: HistoryPage) => [...customerKeys.all, 'loyalty', id, page] as const,
  storeCredit: (id: number, page: HistoryPage) => [...customerKeys.all, 'store-credit', id, page] as const,
  receivables: (id: number, page: HistoryPage) => [...customerKeys.all, 'receivables', id, page] as const,
};

export function useCustomers(params: CustomerListParams) {
  return useQuery({ queryKey: customerKeys.list(params), queryFn: () => listCustomers(params), placeholderData: keepPreviousData });
}

export function useCustomer(id: number | null) {
  return useQuery({ queryKey: customerKeys.detail(id ?? 0), queryFn: () => getCustomer(id!), enabled: id !== null });
}

export function useLoyaltyHistory(id: number, page: HistoryPage, enabled: boolean) {
  return useQuery({ queryKey: customerKeys.loyalty(id, page), queryFn: () => getLoyaltyHistory(id, page), enabled, placeholderData: keepPreviousData });
}

export function useStoreCreditHistory(id: number, page: HistoryPage, enabled: boolean) {
  return useQuery({ queryKey: customerKeys.storeCredit(id, page), queryFn: () => getStoreCreditHistory(id, page), enabled, placeholderData: keepPreviousData });
}

export function useCustomerReceivables(id: number, page: HistoryPage, enabled: boolean) {
  return useQuery({ queryKey: customerKeys.receivables(id, page), queryFn: () => getCustomerReceivables(id, page), enabled, placeholderData: keepPreviousData });
}

function useRefreshCustomers() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: customerKeys.all });
}

export function useCreateCustomer() {
  const refresh = useRefreshCustomers();
  return useMutation({ mutationFn: (body: CreateCustomerRequest) => createCustomer(body), onSuccess: refresh });
}

export function useUpdateCustomer() {
  const refresh = useRefreshCustomers();
  return useMutation({ mutationFn: ({ id, body }: { id: number; body: UpdateCustomerRequest }) => updateCustomer(id, body), onSuccess: refresh });
}

/** One mutation per action, so each button shows its own progress. */
export function useCustomerAction(action: CustomerAction) {
  const refresh = useRefreshCustomers();
  return useMutation({ mutationFn: (id: number) => runCustomerAction(id, action), onSuccess: refresh });
}

export function useRedeemPoints() {
  const refresh = useRefreshCustomers();
  return useMutation({ mutationFn: ({ id, body }: { id: number; body: RedeemPointsRequest }) => redeemPoints(id, body), onSuccess: refresh });
}

export function useAdjustStoreCredit() {
  const refresh = useRefreshCustomers();
  return useMutation({ mutationFn: ({ id, body }: { id: number; body: AdjustStoreCreditRequest }) => adjustStoreCredit(id, body), onSuccess: refresh });
}
