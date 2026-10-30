import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EnterStockCountsRequest, OpenStockCountRequest } from '@bms/shared';
import { inventoryKeys } from '../inventory/queries.js';
import {
  cancelStockCount, enterStockCounts, getStockCount, listStockCounts, openStockCount, postStockCount, recountStockCount, submitStockCount,
  type StockCountParams,
} from './api.js';

/** Query keys for stock counts. Every key starts with `countKeys.all`; a step refreshes the counts and the stock, which posting changes. */
export const countKeys = {
  all: ['stock-counts'] as const,
  list: (params: StockCountParams) => [...countKeys.all, 'list', params] as const,
  one: (id: number) => [...countKeys.all, 'one', id] as const,
};

export function useStockCounts(params: StockCountParams) {
  return useQuery({ queryKey: countKeys.list(params), queryFn: () => listStockCounts(params), placeholderData: keepPreviousData });
}

export function useStockCount(id: number | null) {
  return useQuery({ queryKey: countKeys.one(id ?? 0), queryFn: () => getStockCount(id!), enabled: id !== null });
}

function useCountStep<T>(fn: (v: T) => ReturnType<typeof getStockCount>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: countKeys.all }), qc.invalidateQueries({ queryKey: inventoryKeys.all })]),
  });
}

export const useOpenStockCount = () => useCountStep((body: OpenStockCountRequest) => openStockCount(body));
export const useEnterStockCounts = () => useCountStep(({ id, body }: { id: number; body: EnterStockCountsRequest }) => enterStockCounts(id, body));
export const useSubmitStockCount = () => useCountStep((id: number) => submitStockCount(id));
export const useRecountStockCount = () => useCountStep(({ id, bookIds }: { id: number; bookIds: number[] }) => recountStockCount(id, bookIds));
export const usePostStockCount = () => useCountStep(({ id, zeroBookIds }: { id: number; zeroBookIds: number[] }) => postStockCount(id, zeroBookIds));
export const useCancelStockCount = () => useCountStep(({ id, reason }: { id: number; reason: string }) => cancelStockCount(id, reason));
