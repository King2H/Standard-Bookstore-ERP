import type { z } from 'zod';
import type {
  CollectReceivableRequestSchema, CreatePaymentRequestSchema, OrderBalance, Payment, PaymentListResponse, PaymentRefund,
  PaymentStatus, PosCollectRequest, PosTransaction, Receivable, RefundPaymentRequest, UnpaidListResponse,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/**
 * The payment endpoints (#21), typed with their @bms/shared contracts, and
 * the two other ways a debt is collected: a POS credit sale's own payment
 * endpoint and an exchange difference's receivable. The branch is the
 * session's: the API takes it from there.
 */

export type UnpaidSource = 'order' | 'pos' | 'exchange_difference';

export type UnpaidParams = {
  page?: number;
  pageSize?: number;
  /** With sourceType: one order, POS sale or (exchange difference) receivable. */
  entityId?: string;
  sourceType?: UnpaidSource;
};

/** What customers still owe in the branch: credit orders, POS credit sales and exchange differences. */
export const listUnpaid = (params: UnpaidParams) => api.get<UnpaidListResponse>(`/payments/unpaid-orders${toQuery(params)}`);

export type HistoryParams = {
  page?: number;
  pageSize?: number;
  status?: PaymentStatus;
  /** From this day on, YYYY-MM-DD. */
  dateFrom?: string;
  /** Up to and including this day. */
  dateTo?: string;
};

/** Payments taken in the branch, newest first: on orders, POS credit sales and exchange differences. */
export const listPayments = (params: HistoryParams) => api.get<PaymentListResponse>(`/payments${toQuery(params)}`);

/** One order payment, with its refunds. */
export const getPayment = (id: string) => api.get<Payment>(`/payments/${id}`);

export const getOrderBalance = (orderId: string) => api.get<OrderBalance>(`/orders/${orderId}/balance`);

export type NewOrderPayment = z.input<typeof CreatePaymentRequestSchema>;
export const recordOrderPayment = (body: NewOrderPayment) => api.post<Payment>('/payments', body);

export const collectPosSale = (id: string, body: PosCollectRequest) => api.post<PosTransaction>(`/pos/transactions/${id}/payment`, body);

export type ReceivableCollection = z.input<typeof CollectReceivableRequestSchema>;
export const collectReceivable = (id: string, body: ReceivableCollection) => api.post<Receivable>(`/receivables/${id}/collect`, body);

/** Back the way it was paid; a reason is required. */
export const refundPayment = (id: string, body: RefundPaymentRequest) => api.post<PaymentRefund>(`/payments/${id}/refund`, body);
