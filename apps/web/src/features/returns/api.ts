import type { z } from 'zod';
import type {
  CreateReturnRequestSchema, Order, OrderListResponse, PosTransaction, PosTransactionListResponse, Return, ReturnListResponse,
  SaleServiceLine, ServiceJobStatus,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The return endpoints (#21), typed with their @bms/shared contracts. */

/** `GET /returns` paging; the branch is the session's: the API takes it from there. */
export type ReturnsParams = {
  page?: number;
  pageSize?: number;
  /** The returns of one customer order (#166). */
  orderId?: string;
};

export const listReturns = (params: ReturnsParams) => api.get<ReturnListResponse>(`/returns${toQuery(params)}`);

/** One return, with its lines and how its value went back. */
export const getReturn = (id: string) => api.get<Return>(`/returns/${id}`);

/** A return as the counter sends it: lines and quantities; the refund goes back the way the sale was paid. */
export type NewReturn = z.input<typeof CreateReturnRequestSchema>;

export const createReturn = (body: NewReturn) => api.post<Return>('/returns', body);

/**
 * What a return is made against: a counter sale or a delivered customer
 * order (#166), with its lines and what earlier returns took back of each.
 */
export interface ReturnableSale {
  kind: 'sale' | 'order';
  id: string;
  number: string;
  total: number;
  paid: number;
  status: string;
  /** A voided sale, or an order not delivered, takes no return. */
  returnable: boolean;
  /** When it was sold, or when the order was delivered. */
  date: string;
  lines: ReturnableLine[];
}

export interface ReturnableLine {
  id: string;
  bookTitle: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  returned: number | null;
  /** The line's binding (#169 PR 3): its copies come back only defective. None once cancelled: they are plain copies again. */
  binding: { quantity: number; lineTotal: number; status: ServiceJobStatus | null } | null;
}

function bindingOf(service: SaleServiceLine | null | undefined): ReturnableLine['binding'] {
  if (!service || service.job?.status === 'CANCELLED') return null;
  return { quantity: service.quantity, lineTotal: service.lineTotal, status: service.job?.status ?? null };
}

const DELIVERED = ['FULFILLED', 'COMPLETED', 'Fulfilled'];

function fromSale(t: PosTransaction): ReturnableSale {
  return {
    kind: 'sale', id: t.id, number: t.transactionNumber, total: t.grandTotal, paid: t.amountPaid, status: t.status,
    returnable: t.status !== 'voided', date: t.createdAt,
    lines: (t.lineItems ?? []).map((l) => ({
      id: l.id, bookTitle: l.bookTitle, unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: l.lineTotal, returned: null, binding: bindingOf(l.service),
    })),
  };
}

function fromOrder(o: Order): ReturnableSale {
  return {
    kind: 'order', id: o.id, number: o.orderNumber, total: o.total, paid: o.amountPaid, status: o.status,
    returnable: DELIVERED.includes(o.status) && o.fulfilledAt !== null, date: o.fulfilledAt ?? o.createdAt,
    lines: (o.lineItems ?? []).map((l) => ({
      id: l.id, bookTitle: l.bookTitle, unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: l.totalPrice, returned: l.qtyReturned,
      binding: bindingOf(l.service),
    })),
  };
}

/**
 * The branch's sale or order with this number, with its lines, or an error
 * when there is none: the list finds it by number, the detail brings the
 * lines. An ORD- number is a customer order.
 */
export async function findSale(number: string): Promise<ReturnableSale> {
  if (number.startsWith('ORD')) {
    const found = await api.get<OrderListResponse>(`/orders${toQuery({ orderNumber: number, pageSize: 1 })}`);
    if (found.items.length === 0) throw new Error('Order not found');
    return fromOrder(await api.get<Order>(`/orders/${found.items[0].id}`));
  }
  const found = await api.get<PosTransactionListResponse>(`/pos/transactions${toQuery({ transactionNumber: number, pageSize: 1 })}`);
  if (found.items.length === 0) throw new Error('Transaction not found');
  return fromSale(await api.get<PosTransaction>(`/pos/transactions/${found.items[0].id}`));
}
