import type { Request, Response } from 'express';
import {
  AdjustStoreCreditRequestSchema,
  CreateCustomerGroupRequestSchema,
  CreateCustomerRequestSchema,
  CustomerListQuerySchema,
  IdParamsSchema,
  ListPagingQuerySchema,
  RedeemPointsRequestSchema,
  UpdateCustomerRequestSchema,
  type Customer,
  type CustomerGroup,
  type CustomerGroupListResponse,
  type CustomerListResponse,
  type LoyaltyBalance,
  type LoyaltyHistoryResponse,
  type MessageResponse,
  type StoreCreditBalance,
  type StoreCreditHistoryResponse,
} from '@bms/shared';
import { valid } from '../../middleware/validate.js';
import {
  toCustomerGroupResponse,
  toCustomerResponse,
  toLoyaltyHistoryResponse,
  toStoreCreditHistoryResponse,
} from './customer.mapper.js';
import * as policy from './customer.policy.js';
import * as service from './customer.service.js';
import type { Actor } from './customer.types.js';

/**
 * HTTP side of the Customers module (A3): validated request -> service ->
 * response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: CustomerListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: CreateCustomerRequestSchema },
  update: { params: IdParamsSchema, body: UpdateCustomerRequestSchema },
  history: { params: IdParamsSchema, query: ListPagingQuerySchema },
  redeem: { params: IdParamsSchema, body: RedeemPointsRequestSchema },
  adjust: { params: IdParamsSchema, body: AdjustStoreCreditRequestSchema },
  createGroup: { body: CreateCustomerGroupRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

function message(res: Response, text: string): void {
  const body: MessageResponse = { message: text };
  res.json(body);
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.searchCustomers(
    {
      q: query.q,
      branchId: query.branchId,
      isActive: query.isActive,
      statuses: query.status === undefined ? undefined : policy.statusesFor(query.status),
      groupId: query.groupId,
    },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: CustomerListResponse = { ...result, items: result.items.map(toCustomerResponse) };
  res.json(body);
}

export async function get(req: Request, res: Response): Promise<void> {
  const body: Customer = toCustomerResponse(await service.getCustomerById(valid(req, schemas.byId).params.id));
  res.json(body);
}

export async function create(req: Request, res: Response): Promise<void> {
  const { body: dto } = valid(req, schemas.create);
  const body: Customer = toCustomerResponse(await service.createCustomer(actor(req), dto));
  res.status(201).json(body);
}

export async function update(req: Request, res: Response): Promise<void> {
  const { params, body: dto } = valid(req, schemas.update);
  const body: Customer = toCustomerResponse(await service.updateCustomer(actor(req), params.id, dto));
  res.json(body);
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  await service.deactivateCustomer(actor(req), valid(req, schemas.byId).params.id);
  message(res, 'Customer deactivated');
}

export async function loyalty(req: Request, res: Response): Promise<void> {
  const customer = await service.getCustomerById(valid(req, schemas.byId).params.id);
  const body: LoyaltyBalance = { loyaltyBalance: customer.loyaltyBalance, lifetimePoints: customer.lifetimePoints };
  res.json(body);
}

export async function loyaltyHistory(req: Request, res: Response): Promise<void> {
  const { params, query } = valid(req, schemas.history);
  const result = await service.getLoyaltyHistory(params.id, { page: query.page, pageSize: query.pageSize });
  const body: LoyaltyHistoryResponse = { ...result, items: result.items.map(toLoyaltyHistoryResponse) };
  res.json(body);
}

export async function redeem(req: Request, res: Response): Promise<void> {
  const { params, body: dto } = valid(req, schemas.redeem);
  await service.redeemPoints(actor(req), params.id, {
    points: dto.points,
    reason: dto.reason,
    transactionRef: dto.transactionRef ?? null,
  });
  message(res, 'Points redeemed');
}

export async function storeCredit(req: Request, res: Response): Promise<void> {
  const customer = await service.getCustomerById(valid(req, schemas.byId).params.id);
  const body: StoreCreditBalance = { balance: customer.storeCreditBalance.toNumber() };
  res.json(body);
}

export async function storeCreditHistory(req: Request, res: Response): Promise<void> {
  const { params, query } = valid(req, schemas.history);
  const result = await service.getStoreCreditHistory(params.id, { page: query.page, pageSize: query.pageSize });
  const body: StoreCreditHistoryResponse = { ...result, items: result.items.map(toStoreCreditHistoryResponse) };
  res.json(body);
}

export async function adjustStoreCredit(req: Request, res: Response): Promise<void> {
  const { params, body: dto } = valid(req, schemas.adjust);
  await service.adjustStoreCredit(actor(req), params.id, {
    amount: dto.amount,
    direction: dto.direction,
    reason: dto.reason,
    refType: dto.refType ?? null,
    refId: dto.refId ?? null,
  });
  message(res, `Store credit ${dto.direction} applied`);
}

export async function listGroups(_req: Request, res: Response): Promise<void> {
  const body: CustomerGroupListResponse = { items: (await service.listCustomerGroups()).map(toCustomerGroupResponse) };
  res.json(body);
}

export async function createGroup(req: Request, res: Response): Promise<void> {
  const { body: dto } = valid(req, schemas.createGroup);
  const body: CustomerGroup = toCustomerGroupResponse(await service.createCustomerGroup(actor(req), dto));
  res.status(201).json(body);
}
