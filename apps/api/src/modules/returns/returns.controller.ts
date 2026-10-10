import type { Request, Response } from 'express';
import {
  CreateReturnRequestSchema,
  IdParamsSchema,
  ReturnListQuerySchema,
  type Return,
  type ReturnListResponse,
} from '@bms/shared';
import { AppError } from '../../lib/errors.js';
import { scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toReturnResponse } from './returns.mapper.js';
import * as service from './returns.service.js';
import type { Actor } from './returns.types.js';

/**
 * HTTP side of returns (A3): validated request -> service -> response.
 * The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: ReturnListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: CreateReturnRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

export async function create(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.create);
  const record = await service.createReturn(actor(req), {
    transactionId: body.transactionId,
    reason: body.reason ?? null,
    lines: body.lines,
  });
  const response: Return = toReturnResponse(record);
  res.status(201).json(response);
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.list(
    {
      branchId: scopedBranch(req),
      customerId: query.customerId,
      transactionId: query.transactionId,
      status: query.status,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: ReturnListResponse = {
    items: result.items.map(toReturnResponse),
    total: result.total,
    page: query.page,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
  res.json(body);
}

export async function getById(req: Request, res: Response): Promise<void> {
  const body: Return = toReturnResponse(await service.getById(String(valid(req, schemas.byId).params.id)));
  res.json(body);
}

/**
 * A return is complete when it is made: the stock, the refund and the credit
 * note are booked at once, and above the approval limit a Manager or Admin
 * makes it (owner decision 3a). There is nothing left to reject; a mistaken
 * return is corrected by selling the books again.
 */
export function rejectRetired(): never {
  throw new AppError('DEPRECATED', 'Returns are complete when they are made and can no longer be rejected.', 410);
}
