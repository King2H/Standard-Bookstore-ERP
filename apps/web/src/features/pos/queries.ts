import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inventoryKeys } from '../inventory/queries.js';
import { listSales, voidSale, type SalesParams } from './api.js';

/** Query keys for counter sales. Every key starts with `posKeys.all`. */
export const posKeys = {
  all: ['pos'] as const,
  sales: (params: SalesParams) => [...posKeys.all, 'sales', params] as const,
};

export function useSales(params: SalesParams) {
  return useQuery({ queryKey: posKeys.sales(params), queryFn: () => listSales(params), placeholderData: keepPreviousData });
}

/** Voiding puts the stock back and returns the payments, so the stock lists are refreshed too. */
export function useVoidSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: voidSale,
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: posKeys.all }),
      qc.invalidateQueries({ queryKey: inventoryKeys.all }),
    ]),
  });
}
