import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inventoryKeys } from '../inventory/queries.js';
import { orderKeys } from '../orders/queries.js';
import { paymentKeys } from '../payments/queries.js';
import { posKeys } from '../pos/queries.js';
import { createReturn, findSale, getReturn, listReturns, type ReturnsParams } from './api.js';

/** Query keys for returns. Every key starts with `returnKeys.all`. */
export const returnKeys = {
  all: ['returns'] as const,
  list: (params: ReturnsParams) => [...returnKeys.all, 'list', params] as const,
  detail: (id: string) => [...returnKeys.all, 'detail', id] as const,
  sale: (number: string) => [...returnKeys.all, 'sale', number] as const,
};

export function useReturns(params: ReturnsParams, enabled = true) {
  return useQuery({ queryKey: returnKeys.list(params), queryFn: () => listReturns(params), placeholderData: keepPreviousData, enabled });
}

export function useReturn(id: string) {
  return useQuery({ queryKey: returnKeys.detail(id), queryFn: () => getReturn(id) });
}

/** The sale or order being returned, looked up once a full number is entered. */
export function useSaleByNumber(number: string) {
  return useQuery({
    queryKey: returnKeys.sale(number),
    queryFn: () => findSale(number),
    enabled: number.length > 5,
    retry: false,
  });
}

/** A return puts books back in stock and changes what the sale or order was paid and owes. */
export function useCreateReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createReturn,
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: returnKeys.all }),
      qc.invalidateQueries({ queryKey: posKeys.all }),
      qc.invalidateQueries({ queryKey: orderKeys.all }),
      qc.invalidateQueries({ queryKey: paymentKeys.all }),
      qc.invalidateQueries({ queryKey: inventoryKeys.all }),
    ]),
  });
}
