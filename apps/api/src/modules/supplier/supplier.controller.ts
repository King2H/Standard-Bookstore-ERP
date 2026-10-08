import type { Request, Response } from 'express';
import {
  BookIdParamsSchema,
  BookSupplierParamsSchema,
  CreateSupplierRequestSchema,
  IdParamsSchema,
  LinkBookSupplierRequestSchema,
  SupplierListQuerySchema,
  UpdateSupplierRequestSchema,
  type BookSupplierListResponse,
  type MessageResponse,
  type Supplier,
  type SupplierListResponse,
  type SupplierUsage,
} from '@bms/shared';
import { valid } from '../../middleware/validate.js';
import { toBookSupplierResponse, toSupplierResponse } from './supplier.mapper.js';
import * as policy from './supplier.policy.js';
import * as service from './supplier.service.js';
import type { Actor } from './supplier.types.js';

/**
 * HTTP side of the Suppliers module (A3): validated request -> service ->
 * response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: SupplierListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: CreateSupplierRequestSchema },
  update: { params: IdParamsSchema, body: UpdateSupplierRequestSchema },
  bookSuppliers: { params: BookIdParamsSchema },
  link: { params: BookIdParamsSchema, body: LinkBookSupplierRequestSchema },
  unlink: { params: BookSupplierParamsSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

function message(res: Response, text: string, status = 200): void {
  const body: MessageResponse = { message: text };
  res.status(status).json(body);
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.listSuppliers(
    {
      supplierType: query.supplierType,
      isActive: query.isActive,
      isBlacklisted: query.isBlacklisted,
      statuses: query.status === undefined ? undefined : policy.statusesFor(query.status),
      nameContains: query.q?.trim() || undefined,
    },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: SupplierListResponse = { ...result, items: result.items.map(toSupplierResponse) };
  res.json(body);
}

export async function get(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.byId);
  const body: Supplier = toSupplierResponse(await service.getSupplier(params.id));
  res.json(body);
}

export async function create(req: Request, res: Response): Promise<void> {
  const { body: dto } = valid(req, schemas.create);
  const body: Supplier = toSupplierResponse(await service.createSupplier(actor(req), dto));
  res.status(201).json(body);
}

export async function update(req: Request, res: Response): Promise<void> {
  const { params, body: dto } = valid(req, schemas.update);
  const body: Supplier = toSupplierResponse(await service.updateSupplier(actor(req), params.id, dto));
  res.json(body);
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  await service.deactivateSupplier(actor(req), valid(req, schemas.byId).params.id);
  message(res, 'Supplier deactivated');
}

export async function activate(req: Request, res: Response): Promise<void> {
  await service.activateSupplier(actor(req), valid(req, schemas.byId).params.id);
  message(res, 'Supplier activated');
}

export async function blacklist(req: Request, res: Response): Promise<void> {
  await service.blacklistSupplier(actor(req), valid(req, schemas.byId).params.id);
  message(res, 'Supplier blacklisted');
}

export async function archive(req: Request, res: Response): Promise<void> {
  await service.archiveSupplier(actor(req), valid(req, schemas.byId).params.id);
  message(res, 'Supplier archived');
}

export async function restore(req: Request, res: Response): Promise<void> {
  await service.restoreSupplier(actor(req), valid(req, schemas.byId).params.id);
  message(res, 'Supplier restored');
}

export async function usage(req: Request, res: Response): Promise<void> {
  const body: SupplierUsage = await service.getSupplierUsage(valid(req, schemas.byId).params.id);
  res.json(body);
}

export async function remove(req: Request, res: Response): Promise<void> {
  await service.deleteSupplier(actor(req), valid(req, schemas.byId).params.id);
  message(res, 'Supplier deleted');
}

export async function listForBook(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.bookSuppliers);
  const items = await service.listBookSuppliers(params.bookId);
  const body: BookSupplierListResponse = { items: items.map(toBookSupplierResponse) };
  res.json(body);
}

export async function linkToBook(req: Request, res: Response): Promise<void> {
  const { params, body: dto } = valid(req, schemas.link);
  await service.linkBookSupplier(actor(req), params.bookId, dto);
  message(res, 'Supplier linked to book', 201);
}

export async function unlinkFromBook(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.unlink);
  await service.unlinkBookSupplier(actor(req), params.bookId, params.supplierId);
  message(res, 'Supplier unlinked from book');
}
