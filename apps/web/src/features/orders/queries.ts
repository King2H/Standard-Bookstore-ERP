import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inventoryKeys } from '../inventory/queries.js';
import {
  cancelOrder, confirmOrder, deleteOrder, fulfillOrder, getOrder, listOrders, type ConfirmOrder, type OrdersParams,
} from './api.js';

/** Query keys for orders. Every key starts with `orderKeys.all`. */
export const orderKeys = {
  all: ['orders'] as const,
  list: (params: OrdersParams) => [...orderKeys.all, 'list', params] as const,
  detail: (id: string) => [...orderKeys.all, 'detail', id] as const,
};

export function useOrders(params: OrdersParams) {
  return useQuery({ queryKey: orderKeys.list(params), queryFn: () => listOrders(params), placeholderData: keepPreviousData });
}

export function useOrder(id: string) {
  return useQuery({ queryKey: orderKeys.detail(id), queryFn: () => getOrder(id) });
}

/** Confirming, fulfilling and cancelling move stock (reserved, delivered, put back). */
function useOrderStep<A, R>(mutationFn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: orderKeys.all }),
      qc.invalidateQueries({ queryKey: inventoryKeys.all }),
    ]),
  });
}

export const useConfirmOrder = () => useOrderStep(({ id, body }: { id: string; body: ConfirmOrder }) => confirmOrder(id, body));
export const useFulfillOrder = () => useOrderStep(fulfillOrder);
export const useCancelOrder = () => useOrderStep(({ id, reason }: { id: string; reason: string }) => cancelOrder(id, { reason }));

export function useDeleteOrder() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: deleteOrder, onSuccess: () => qc.invalidateQueries({ queryKey: orderKeys.all }) });
}
