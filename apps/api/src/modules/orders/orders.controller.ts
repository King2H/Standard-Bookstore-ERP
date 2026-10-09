import type { Request, Response } from 'express';
import {
  CancelOrderRequestSchema,
  CollectOrderPaymentRequestSchema,
  ConfirmOrderRequestSchema,
  CreateOrderRequestSchema,
  IdParamsSchema,
  OrderListQuerySchema,
  type MessageResponse,
  type Order,
  type OrderListResponse,
} from '@bms/shared';
import { valid } from '../../middleware/validate.js';
import { withIdempotency, hashBody } from '../../lib/idempotency.js';
import type { Permission } from '../../lib/permissions.js';
import { assertLocationUsable, scopedBranch } from '../../lib/scope.js';
import { computeOrderAllowedActions } from './orders.policy.js';
import * as service from './orders.service.js';
import type { OrderRow } from './orders.types.js';

/**
 * HTTP side of the Orders module (A3): validated request -> service ->
 * response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: OrderListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: CreateOrderRequestSchema },
  confirm: { params: IdParamsSchema, body: ConfirmOrderRequestSchema },
  cancel: { params: IdParamsSchema, body: CancelOrderRequestSchema },
  collectPayment: { params: IdParamsSchema, body: CollectOrderPaymentRequestSchema },
};

/** The order as the API returns it, with the actions this staff member may take. */
function toResponse(req: Request, order: OrderRow): Order {
  const permissions = (req.staff!.permissions ?? []) as Permission[];
  return {
    ...order,
    paymentMethod: order.paymentMethod ?? null,
    dueDate: order.dueDate ?? null,
    allowedActions: computeOrderAllowedActions(order.status, permissions, order.paymentStatus, order.saleType),
  };
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list({ ...query, branchId: scopedBranch(req) });
  const body: OrderListResponse = {
    ...result,
    pageSize: query.pageSize,
    items: result.items.map((o) => toResponse(req, o)),
  };
  res.json(body);
}

export async function get(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.byId);
  res.json(toResponse(req, await service.getById(params.id)));
}

/**
 * With an Idempotency-Key header, a repeated request returns the order the
 * first one created (200, X-Idempotent-Replayed) instead of creating another.
 */
export async function create(req: Request, res: Response): Promise<void> {
  const { body: dto } = valid(req, schemas.create);
  await assertLocationUsable(req, dto.locationId ?? null);
  const data = {
    ...dto,
    customerId: dto.customerId ?? null,
    locationId: dto.locationId ?? null,
    items: dto.items.map((i) => ({ ...i, discountAmount: i.discountAmount ?? undefined, discountPct: i.discountPct ?? undefined })),
  };
  const idempotencyKey = req.headers['idempotency-key'];
  if (typeof idempotencyKey === 'string' && idempotencyKey) {
    const { result, replayed } = await withIdempotency(idempotencyKey, '/orders', hashBody(data), () =>
      service.create(data, req.staff!),
    );
    if (replayed) res.setHeader('X-Idempotent-Replayed', 'true');
    res.status(replayed ? 200 : 201).json(toResponse(req, result));
    return;
  }
  res.status(201).json(toResponse(req, await service.create(data, req.staff!)));
}

export async function confirm(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.confirm);
  const order = await service.confirm(params.id, req.staff!, body.dueDate ?? null, body.paymentMethod ?? null);
  res.json(toResponse(req, order));
}

export async function fulfill(req: Request, res: Response): Promise<void> {
  res.json(toResponse(req, await service.fulfill(valid(req, schemas.byId).params.id, req.staff!)));
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.cancel);
  res.json(toResponse(req, await service.cancel(params.id, body.reason, req.staff!)));
}

export async function collectPayment(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.collectPayment);
  res.json(toResponse(req, await service.collectPayment(params.id, body.amount, req.staff!)));
}

/** Legacy (#69): returns the order without computing its actions, as before. */
export async function progress(req: Request, res: Response): Promise<void> {
  res.json(await service.progress(valid(req, schemas.byId).params.id, req.staff!));
}

export async function remove(req: Request, res: Response): Promise<void> {
  await service.deleteOrder(valid(req, schemas.byId).params.id, req.staff!);
  const body: MessageResponse = { message: 'Order deleted' };
  res.json(body);
}
