import type { Request, Response } from 'express';
import {
  BranchListQuerySchema,
  CreateBranchRequestSchema,
  IdParamsSchema,
  UpdateBranchRequestSchema,
  type Branch,
  type BranchListResponse,
  type MessageResponse,
  type PublicBranchListResponse,
} from '@bms/shared';
import { scopeOf } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toBranchResponse } from './branch.mapper.js';
import * as service from './branch.service.js';
import type { Actor } from './branch.types.js';

/**
 * HTTP side of the Branches module (A3): validated request -> service ->
 * response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: BranchListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: CreateBranchRequestSchema },
  update: { params: IdParamsSchema, body: UpdateBranchRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller but publicList. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId, allBranches: scopeOf(req).allBranches };
}

function message(res: Response, text: string): void {
  const body: MessageResponse = { message: text };
  res.json(body);
}

export async function publicList(_req: Request, res: Response): Promise<void> {
  const { items } = await service.listBranches({ isActive: true }, { page: 1, pageSize: 100 });
  const body: PublicBranchListResponse = { items: items.map((b) => ({ id: b.id, name: b.name })) };
  res.json(body);
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.listBranches({ isActive: query.isActive }, { page: query.page, pageSize: query.pageSize });
  const body: BranchListResponse = { ...result, items: result.items.map(toBranchResponse) };
  res.json(body);
}

export async function get(req: Request, res: Response): Promise<void> {
  const body: Branch = toBranchResponse(await service.getBranch(valid(req, schemas.byId).params.id));
  res.json(body);
}

export async function create(req: Request, res: Response): Promise<void> {
  const { body: dto } = valid(req, schemas.create);
  const body: Branch = toBranchResponse(await service.createBranch(actor(req), dto));
  res.status(201).json(body);
}

export async function update(req: Request, res: Response): Promise<void> {
  const { params, body: dto } = valid(req, schemas.update);
  const body: Branch = toBranchResponse(await service.updateBranch(actor(req), params.id, dto));
  res.json(body);
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  await service.deactivateBranch(actor(req), valid(req, schemas.byId).params.id);
  message(res, 'Branch deactivated');
}

export async function reactivate(req: Request, res: Response): Promise<void> {
  await service.reactivateBranch(actor(req), valid(req, schemas.byId).params.id);
  message(res, 'Branch reactivated');
}

export async function remove(req: Request, res: Response): Promise<void> {
  await service.deleteBranch(actor(req), valid(req, schemas.byId).params.id);
  message(res, 'Branch deleted');
}
