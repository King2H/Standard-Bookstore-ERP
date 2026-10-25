import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inventoryKeys } from '../inventory/queries.js';
import { createSale, getSale, listSales, searchBooksForSale, searchCustomersForSale, voidSale, type SalesParams } from './api.js';

/** Query keys for counter sales. Every key starts with `posKeys.all`. */
export const posKeys = {
  all: ['pos'] as const,
  sales: (params: SalesParams) => [...posKeys.all, 'sales', params] as const,
  sale: (id: string) => [...posKeys.all, 'sale', id] as const,
};

/** One sale with its lines, read when its details are opened. */
export function useSale(id: string | null) {
  return useQuery({ queryKey: posKeys.sale(id ?? ''), queryFn: () => getSale(id as string), enabled: id !== null });
}

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

/** A sale changes stock and, on credit, what the customer owes. */
export function useCreateSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createSale,
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: posKeys.all }),
      qc.invalidateQueries({ queryKey: inventoryKeys.all }),
    ]),
  });
}

export function useBooksForSale(q: string, locationId: number | null) {
  return useQuery({
    queryKey: [...posKeys.all, 'books', q, locationId] as const,
    queryFn: () => searchBooksForSale(q, locationId),
    enabled: q.length > 1,
  });
}

export function useCustomersForSale(q: string) {
  return useQuery({
    queryKey: [...posKeys.all, 'customers', q] as const,
    queryFn: () => searchCustomersForSale(q),
    enabled: q.length > 1,
  });
}
