import type { z } from 'zod';
import type {
  BookAvailabilityListResponse, CancelOrderRequest, ConfirmOrderRequestSchema, CreateOrderRequestSchema, CustomerListResponse,
  DeliverOrderRequest, Order, OrderListResponse,
} from '@bms/shared';
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
  /** The order with this ORD- number. */
  orderNumber?: string;
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

/** Some copies handed over, per line at most what is waiting (#174); numbered DLV-. */
export const deliverOrder = (id: string, body: DeliverOrderRequest) => api.post<Order>(`/orders/${id}/deliveries`, body);

/** What a part-delivered order will not deliver is cancelled; the order is completed (#174). */
export const cancelOrderRest = (id: string, body: CancelOrderRequest) => api.post<Order>(`/orders/${id}/cancel-rest`, body);

/** A special-order line's copies brought to the order's location reserved for it (#174). */
export const reserveOrderLine = (id: string, lineId: string) => api.post<Order>(`/orders/${id}/lines/${lineId}/reserve`);

/** Cancelled with a reason (owner decision 2a); a confirmed order's stock goes back. */
export const cancelOrder = (id: string, body: CancelOrderRequest) => api.post<Order>(`/orders/${id}/cancel`, body);

/** Only a draft or cancelled order with no history; Admin only. */
export const deleteOrder = (id: string) => api.delete<void>(`/orders/${id}`);

/** A new order, as the form sends it; the branch is the session's. */
export type NewOrder = z.input<typeof CreateOrderRequestSchema>;

/** Created as a draft; the form confirms it at once. */
export const createOrder = (body: NewOrder) => api.post<Order>('/orders', body);

/** A draft's new contents, checked as a new order is (#174). */
export const updateOrder = (id: string, body: NewOrder) => api.put<Order>(`/orders/${id}`, body);

/** Books matching what was typed, with their stock at the order's location and the branch's price. */
export const searchBooksForOrder = (q: string, locationId: number | null) =>
  api.get<BookAvailabilityListResponse>(`/books/with-availability${toQuery({ q, pageSize: 8, locationId })}`);

/** Active customers only: the API refuses an order for an inactive one. */
export const searchCustomersForOrder = (q: string) =>
  api.get<CustomerListResponse>(`/customers${toQuery({ q, pageSize: 5, status: 'active' })}`);
