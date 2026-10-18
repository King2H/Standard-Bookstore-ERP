import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdjustStockRequest, ReorderPointRequest, StockInRequest, StockOutRequest, TransferStockRequest } from '@bms/shared';
import {
  adjustStock, listLowStock, listStockLevels, listStockMovements, setReorderPoint, stockIn, stockOut, transferStock,
  type StockLevelParams, type StockMovementParams,
} from './api.js';

/**
 * Query keys for stock. Every key starts with `inventoryKeys.all`, so a stock
 * change refreshes the levels, the low-stock list and its badge, and the history.
 */
export const inventoryKeys = {
  all: ['inventory'] as const,
  levels: (params: StockLevelParams) => [...inventoryKeys.all, 'levels', params] as const,
  lowStock: (params: { page?: number; pageSize?: number }) => [...inventoryKeys.all, 'low-stock', params] as const,
  history: (params: StockMovementParams) => [...inventoryKeys.all, 'history', params] as const,
};

export function useStockLevels(params: StockLevelParams) {
  return useQuery({
    queryKey: inventoryKeys.levels(params),
    queryFn: () => listStockLevels(params),
    placeholderData: keepPreviousData,
    staleTime: 0,
    retry: 2,
    refetchOnWindowFocus: true,
  });
}

/** Refreshed every minute: the badge on the tab and the Low Stock list. */
export function useLowStock(params: { page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: inventoryKeys.lowStock(params),
    queryFn: () => listLowStock(params),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** The book-and-location picker: asks once two characters are typed. */
export function useStockSearch(q: string) {
  const params: StockLevelParams = { q, pageSize: 10 };
  return useQuery({ queryKey: inventoryKeys.levels(params), queryFn: () => listStockLevels(params), enabled: q.length > 1 });
}

export function useStockMovements(params: StockMovementParams) {
  return useQuery({ queryKey: inventoryKeys.history(params), queryFn: () => listStockMovements(params), placeholderData: keepPreviousData });
}

export function useSetReorderPoint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReorderPointRequest) => setReorderPoint(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventoryKeys.all }),
  });
}

export function useStockIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StockInRequest) => stockIn(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventoryKeys.all }),
  });
}

export function useStockOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StockOutRequest) => stockOut(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventoryKeys.all }),
  });
}

export function useAdjustStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AdjustStockRequest) => adjustStock(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventoryKeys.all }),
  });
}

export function useTransferStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TransferStockRequest) => transferStock(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: inventoryKeys.all }),
  });
}
