import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LinkSpecialOrdersRequest } from '@bms/shared';
import { purchaseOrderKeys } from '../procurement/queries.js';
import { linkSpecialOrders, listSpecialOrders, startPurchaseOrder } from './api.js';

export const specialOrderKeys = {
  all: ['special-orders'] as const,
  list: (params: { toOrder?: boolean; page?: number; pageSize?: number }) => [...specialOrderKeys.all, 'list', params] as const,
};

export function useSpecialOrders(params: { toOrder?: boolean; page?: number; pageSize?: number }) {
  return useQuery({ queryKey: specialOrderKeys.list(params), queryFn: () => listSpecialOrders(params), placeholderData: keepPreviousData });
}

/** Buying special orders changes the lines to buy and the purchase orders. */
function useBuying<A, R>(mutationFn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => Promise.all([specialOrderKeys.all, purchaseOrderKeys.all].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export const useLinkSpecialOrders = () => useBuying(({ poId, body }: { poId: string; body: LinkSpecialOrdersRequest }) => linkSpecialOrders(poId, body));
export const useStartPurchaseOrder = () => useBuying(startPurchaseOrder);
