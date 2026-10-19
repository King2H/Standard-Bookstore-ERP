import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bookKeys } from '../catalog/queries.js';
import { inventoryKeys } from '../inventory/queries.js';
import {
  createExchange, getExchange, listExchanges, quickRegisterBook, searchBooksForExchange, searchCustomersForExchange,
  voidExchange, type ExchangesParams,
} from './api.js';

/** Query keys for exchanges. Every key starts with `exchangeKeys.all`. */
export const exchangeKeys = {
  all: ['exchanges'] as const,
  list: (params: ExchangesParams) => [...exchangeKeys.all, 'list', params] as const,
  detail: (id: string) => [...exchangeKeys.all, 'detail', id] as const,
  books: (q: string, locationId: number | null) => [...exchangeKeys.all, 'books', q, locationId] as const,
  customers: (q: string) => [...exchangeKeys.all, 'customers', q] as const,
};

export function useExchanges(params: ExchangesParams, enabled = true) {
  return useQuery({ queryKey: exchangeKeys.list(params), queryFn: () => listExchanges(params), placeholderData: keepPreviousData, enabled });
}

export function useExchange(id: string) {
  return useQuery({ queryKey: exchangeKeys.detail(id), queryFn: () => getExchange(id) });
}

export function useBooksForExchange(q: string, locationId: number | null) {
  return useQuery({ queryKey: exchangeKeys.books(q, locationId), queryFn: () => searchBooksForExchange(q, locationId), enabled: q.length > 1 });
}

export function useCustomersForExchange(q: string) {
  return useQuery({ queryKey: exchangeKeys.customers(q), queryFn: () => searchCustomersForExchange(q), enabled: q.length > 1 });
}

/** An exchange moves stock both ways and may change what the customer owes or holds. */
function useStockChange<A, R>(mutationFn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: exchangeKeys.all }),
      qc.invalidateQueries({ queryKey: inventoryKeys.all }),
    ]),
  });
}

export const useCreateExchange = () => useStockChange(createExchange);

export const useVoidExchange = () => useStockChange(({ id, reason }: { id: string; reason: string }) => voidExchange(id, reason));

/** A new catalog entry is searchable everywhere, so the book lists are refreshed. */
export function useQuickRegisterBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: quickRegisterBook,
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: exchangeKeys.all }),
      qc.invalidateQueries({ queryKey: bookKeys.all }),
    ]),
  });
}
