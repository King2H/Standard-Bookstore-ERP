import type { z } from 'zod';
import type { CancelOrderRequest, ConfirmOrderRequestSchema, Order, OrderListResponse } from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The order endpoints (#20), typed with their @bms/shared contracts. */

/**
 * `GET /orders` filters, as they travel in the query string. The branch is
 * the session's: the API takes it from there.
 */
export type OrdersParams = {
  page?: number;
  pageSize?: number;
  /** One status, or several separated by commas. */
  status?: string;
  dateFrom?: string;
  dateTo?: string;
};

export const listOrders = (params: OrdersParams) => api.get<OrderListResponse>(`/orders${toQuery(params)}`);

/** One order, with its lines. */
export const getOrder = (id: string) => api.get<Order>(`/orders/${id}`);

export type ConfirmOrder = z.input<typeof ConfirmOrderRequestSchema>;

/** A draft is confirmed: a cash order is paid now, a credit order owes by its due date. */
export const confirmOrder = (id: string, body: ConfirmOrder) => api.post<Order>(`/orders/${id}/confirm`, body);

/** The books are handed over. */
export const fulfillOrder = (id: string) => api.post<Order>(`/orders/${id}/fulfill`);

/** Cancelled with a reason (owner decision 2a); a confirmed order's stock goes back. */
export const cancelOrder = (id: string, body: CancelOrderRequest) => api.post<Order>(`/orders/${id}/cancel`, body);

/** Only a draft or cancelled order with no history; Admin only. */
export const deleteOrder = (id: string) => api.delete<void>(`/orders/${id}`);
