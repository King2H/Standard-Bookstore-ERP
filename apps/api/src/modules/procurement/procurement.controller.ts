import type { Request, Response } from 'express';
import {
  ApprovePurchaseOrderRequestSchema,
  BooksToOrderQuerySchema,
  ClosePurchaseOrderRequestSchema,
  CreatePurchaseOrderRequestSchema,
  IdParamsSchema,
  LinkSpecialOrdersRequestSchema,
  Money,
  PurchaseOrderListQuerySchema,
  ReceivePurchaseOrderRequestSchema,
  UpdatePurchaseOrderRequestSchema,
  type BooksToOrderResponse,
  type PurchaseOrder,
  type PurchaseOrderLineInput,
  type PurchaseOrderListResponse,
} from '@bms/shared';
import { assertLocationUsable, bookingBranch, scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toPurchaseOrderResponse } from './procurement.mapper.js';
import * as service from './procurement.service.js';
import type { Actor, NewLine, PurchaseOrderView } from './procurement.types.js';

/**
 * HTTP side of purchase orders (A3): validated request -> service -> response.
 * The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: PurchaseOrderListQuerySchema },
  books: { query: BooksToOrderQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: CreatePurchaseOrderRequestSchema },
  update: { params: IdParamsSchema, body: UpdatePurchaseOrderRequestSchema },
  receive: { params: IdParamsSchema, body: ReceivePurchaseOrderRequestSchema },
  approve: { params: IdParamsSchema, body: ApprovePurchaseOrderRequestSchema },
  close: { params: IdParamsSchema, body: ClosePurchaseOrderRequestSchema },
  linkSpecialOrders: { params: IdParamsSchema, body: LinkSpecialOrdersRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, roles, branchId } = req.staff!;
  return { staffId, role, roles: roles?.length ? roles : [role], branchId };
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

function send(res: Response, record: PurchaseOrderView, status = 200): void {
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
    currency: body.currency,
    specialOrders: body.specialOrders,
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
      currency: body.currency,
    }),
  );
}

export async function submit(req: Request, res: Response): Promise<void> {
  send(res, await service.submitForApproval(actor(req), idOf(req)));
}

export async function approve(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.approve);
  send(res, await service.approve(actor(req), String(params.id), body.reason ?? null));
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

/** Special-order lines of the session branch added to the purchase order (#174). */
export async function linkSpecialOrders(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.linkSpecialOrders);
  send(res, await service.linkSpecialOrders(actor(req), String(params.id), body.lines));
}

export async function cancel(req: Request, res: Response): Promise<void> {
  send(res, await service.cancel(actor(req), idOf(req)));
}

export async function close(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.close);
  send(res, await service.close(actor(req), String(params.id), body.reason ?? null));
}

/** The branch's stock comes from the session (another branch only with access to all branches). */
export async function booksToOrder(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.books);
  const branchId = scopedBranch(req);
  const body: BooksToOrderResponse = { branchId, items: await service.booksToOrder(query.q, branchId, query.limit) };
  res.json(body);
}
