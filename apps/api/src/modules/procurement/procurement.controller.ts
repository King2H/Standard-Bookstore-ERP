import type { Request, Response } from 'express';
import {
  ClosePurchaseOrderRequestSchema,
  CreatePurchaseOrderRequestSchema,
  IdParamsSchema,
  Money,
  PurchaseOrderListQuerySchema,
  ReceivePurchaseOrderRequestSchema,
  UpdatePurchaseOrderRequestSchema,
  type PurchaseOrder,
  type PurchaseOrderLineInput,
  type PurchaseOrderListResponse,
} from '@bms/shared';
import { assertLocationUsable, bookingBranch, scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toPurchaseOrderResponse } from './procurement.mapper.js';
import * as service from './procurement.service.js';
import type { Actor, NewLine, PurchaseOrderRecord } from './procurement.types.js';

/**
 * HTTP side of purchase orders (A3): validated request -> service -> response.
 * The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: PurchaseOrderListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: CreatePurchaseOrderRequestSchema },
  update: { params: IdParamsSchema, body: UpdatePurchaseOrderRequestSchema },
  receive: { params: IdParamsSchema, body: ReceivePurchaseOrderRequestSchema },
  close: { params: IdParamsSchema, body: ClosePurchaseOrderRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

function lines(items: PurchaseOrderLineInput[]): NewLine[] {
  return items.map((l) => ({
    bookId: l.bookId,
    formatId: l.formatId ?? null,
    editionId: l.editionId ?? null,
    quantity: l.quantity,
    unitCost: Money.of(l.unitCost),
  }));
}

function send(res: Response, record: PurchaseOrderRecord, status = 200): void {
  const body: PurchaseOrder = toPurchaseOrderResponse(record);
  res.status(status).json(body);
}

const idOf = (req: Request) => String(valid(req, schemas.byId).params.id);

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list(
    {
      branchId: scopedBranch(req),
      status: query.status,
      supplierId: query.supplierId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: PurchaseOrderListResponse = {
    items: result.items.map(toPurchaseOrderResponse),
    total: result.total,
    page: query.page,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}

export async function getById(req: Request, res: Response): Promise<void> {
  send(res, await service.getById(idOf(req)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.create);
  const record = await service.createPurchaseOrder(actor(req), {
    supplierId: body.supplierId,
    branchId: bookingBranch(req, body.branchId),
    receivingBranchId: body.receivingBranchId ?? null,
    receivingLocationId: body.receivingLocationId ?? null,
    expectedDeliveryDate: body.expectedDeliveryDate ?? null,
    notes: body.notes ?? null,
    paymentTerms: body.paymentTerms,
    lineItems: lines(body.lineItems),
  });
  send(res, record, 201);
}

export async function update(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.update);
  send(
    res,
    await service.updatePurchaseOrder(actor(req), String(params.id), {
      supplierId: body.supplierId,
      receivingBranchId: body.receivingBranchId,
      receivingLocationId: body.receivingLocationId,
      expectedDeliveryDate: body.expectedDeliveryDate,
      notes: body.notes,
      paymentTerms: body.paymentTerms,
      lineItems: body.lineItems && lines(body.lineItems),
    }),
  );
}

export async function submit(req: Request, res: Response): Promise<void> {
  send(res, await service.submitForApproval(actor(req), idOf(req)));
}

export async function approve(req: Request, res: Response): Promise<void> {
  send(res, await service.approve(actor(req), idOf(req)));
}

export async function markAsOrdered(req: Request, res: Response): Promise<void> {
  send(res, await service.markAsOrdered(actor(req), idOf(req)));
}

export async function receive(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.receive);
  // A named location is in the session's branch; the service checks the one used.
  await assertLocationUsable(req, body.locationId ?? null);
  send(
    res,
    await service.receive(actor(req), String(params.id), {
      locationId: body.locationId ?? null,
      items: body.items,
      notes: body.notes ?? null,
    }),
  );
}

export async function cancel(req: Request, res: Response): Promise<void> {
  send(res, await service.cancel(actor(req), idOf(req)));
}

export async function close(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.close);
  send(res, await service.close(actor(req), String(params.id), body.reason ?? null));
}
