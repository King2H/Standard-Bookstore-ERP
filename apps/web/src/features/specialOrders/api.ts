import type { z } from 'zod';
import type { CreatePurchaseOrderRequestSchema, LinkSpecialOrdersRequest, PurchaseOrder, SpecialOrderListResponse } from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** Special orders (#174): the copies customers wait for, and the purchase orders that buy them. */

/** The branch's special-order lines with copies on order; `toOrder`: only those on no purchase order yet. */
export const listSpecialOrders = (params: { toOrder?: boolean; page?: number; pageSize?: number }) =>
  api.get<SpecialOrderListResponse>(`/special-orders${toQuery({ ...params, toOrder: params.toOrder ? 'true' : undefined })}`);

/** Lines added to a purchase order: a draft's line for each book grows, or is created at its unit cost. */
export const linkSpecialOrders = (poId: string, body: LinkSpecialOrdersRequest) =>
  api.post<PurchaseOrder>(`/purchase-orders/${poId}/special-orders`, body);

/** A new draft purchase order for a supplier, of special-order lines alone. */
export const startPurchaseOrder = (body: z.input<typeof CreatePurchaseOrderRequestSchema>) => api.post<PurchaseOrder>('/purchase-orders', body);
