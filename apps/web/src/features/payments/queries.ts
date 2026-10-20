import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PosCollectRequest, RefundPaymentRequest } from '@bms/shared';
import { customerKeys } from '../customers/queries.js';
import { orderKeys } from '../orders/queries.js';
import { posKeys } from '../pos/queries.js';
import { receivableKeys } from '../receivables/queries.js';
import {
  collectPosSale, collectReceivable, getOrderBalance, getPayment, listPayments, listUnpaid, recordOrderPayment, refundPayment,
  type HistoryParams, type NewOrderPayment, type ReceivableCollection, type UnpaidParams,
} from './api.js';

/** Query keys for payments. Every key starts with `paymentKeys.all` (the live stream refreshes them). */
export const paymentKeys = {
  all: ['payments'] as const,
  unpaid: (params: UnpaidParams) => [...paymentKeys.all, 'unpaid', params] as const,
  history: (params: HistoryParams) => [...paymentKeys.all, 'history', params] as const,
  detail: (id: string) => [...paymentKeys.all, 'detail', id] as const,
  balance: (orderId: string) => [...paymentKeys.all, 'balance', orderId] as const,
};

/** Refreshed every 30 seconds: other tills take payments too. */
export function useUnpaid(params: UnpaidParams, enabled = true) {
  return useQuery({
    queryKey: paymentKeys.unpaid(params), queryFn: () => listUnpaid(params), enabled,
    placeholderData: keepPreviousData, refetchInterval: 30_000,
  });
}

export function usePaymentHistory(params: HistoryParams) {
  return useQuery({ queryKey: paymentKeys.history(params), queryFn: () => listPayments(params), placeholderData: keepPreviousData });
}

export function usePayment(id: string) {
  return useQuery({ queryKey: paymentKeys.detail(id), queryFn: () => getPayment(id) });
}

export function useOrderBalance(orderId: string | null) {
  return useQuery({ queryKey: paymentKeys.balance(orderId ?? ''), queryFn: () => getOrderBalance(orderId!), enabled: orderId !== null });
}

/**
 * Money taken or given back changes the debt (orders, POS sales,
 * receivables) and the customer's balances.
 */
function useMoneyStep<A, R>(mutationFn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: paymentKeys.all }),
      qc.invalidateQueries({ queryKey: orderKeys.all }),
      qc.invalidateQueries({ queryKey: posKeys.all }),
      qc.invalidateQueries({ queryKey: customerKeys.all }),
      qc.invalidateQueries({ queryKey: receivableKeys.all }),
    ]),
  });
}

/** A collection goes to the endpoint of what is owed: an order, a POS credit sale, or an exchange difference's receivable. */
export type CollectInput =
  | { sourceType: 'order'; body: NewOrderPayment }
  | { sourceType: 'pos'; id: string; body: PosCollectRequest }
  | { sourceType: 'exchange_difference'; id: string; body: ReceivableCollection };

export function useCollectPayment() {
  return useMoneyStep(async (c: CollectInput): Promise<void> => {
    if (c.sourceType === 'order') await recordOrderPayment(c.body);
    else if (c.sourceType === 'pos') await collectPosSale(c.id, c.body);
    else await collectReceivable(c.id, c.body);
  });
}

export const useRefundPayment = () => useMoneyStep(({ id, body }: { id: string; body: RefundPaymentRequest }) => refundPayment(id, body));
