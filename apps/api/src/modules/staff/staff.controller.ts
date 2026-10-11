import type { Request, Response } from 'express';
import {
  CreateStaffRequestSchema,
  IdParamsSchema,
  ResetPasswordRequestSchema,
  SetAllBranchesRequestSchema,
  SetStaffRolesRequestSchema,
  StaffListQuerySchema,
  UpdateStaffRequestSchema,
  type Staff,
  type StaffListResponse,
} from '@bms/shared';
import { valid } from '../../middleware/validate.js';
import * as service from './staff.service.js';
import type { StaffRecord } from './staff.types.js';

/**
 * HTTP side of staff administration (A3): validated request -> service ->
 * response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: StaffListQuerySchema },
  byId: { params: IdParamsSchema },
  create: { body: CreateStaffRequestSchema },
  update: { params: IdParamsSchema, body: UpdateStaffRequestSchema },
  roles: { params: IdParamsSchema, body: SetStaffRolesRequestSchema },
  allBranches: { params: IdParamsSchema, body: SetAllBranchesRequestSchema },
  resetPassword: { params: IdParamsSchema, body: ResetPasswordRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request) {
  const { staffId, role, roles, branchId } = req.staff!;
  return { staffId, role, roles: roles ?? [role], branchId, isAllBranches: req.scope!.allBranches };
}

function toStaff(s: StaffRecord, canManage: boolean): Staff {
  return {
    id: s.id,
    username: s.username,
    fullName: s.fullName,
    isActive: s.isActive,
    createdAt: s.createdAt.toISOString(),
    mustChangePassword: s.mustChangePassword,
    lockedUntil: s.lockedUntil?.toISOString() ?? null,
    failedLoginAttempts: s.failedLoginAttempts,
    lastLoginAt: s.lastLoginAt?.toISOString() ?? null,
    passwordChangedAt: s.passwordChangedAt?.toISOString() ?? null,
    isAllBranches: s.isAllBranches,
    roles: s.roles,
    canManage,
  };
}

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const { items, total } = await service.list(actor(req), { limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
  const body: StaffListResponse = {
    items: items.map((i) => toStaff(i.record, i.canManage)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.ceil(total / query.pageSize),
  };
  res.json(body);
}

export async function getById(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.byId);
  const { record, canManage } = await service.getById(actor(req), params.id);
  res.json(toStaff(record, canManage));
}

export async function create(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.create);
  const staffId = await service.create(actor(req), body);
  res.status(201).json({ staffId });
}

export async function update(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.update);
  await service.updateName(actor(req), params.id, body.fullName);
  res.json({ message: 'Staff updated' });
}

export async function setRoles(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.roles);
  await service.setRoles(actor(req), params.id, body);
  res.json({ message: 'Roles updated' });
}

export async function setAllBranches(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.allBranches);
  await service.setAllBranches(actor(req), params.id, body.isAllBranches);
  res.json({ message: body.isAllBranches ? 'All-branch access granted' : 'All-branch access revoked' });
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.byId);
  await service.deactivate(actor(req), params.id);
  res.json({ message: 'Staff deactivated' });
}

export async function reactivate(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.byId);
  await service.reactivate(actor(req), params.id);
  res.json({ message: 'Staff reactivated' });
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.resetPassword);
  await service.resetPassword(actor(req), params.id, body.temporaryPassword);
  res.json({ message: 'Password reset. Staff must change password on next login.' });
}

export async function unlock(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.byId);
  await service.unlock(actor(req), params.id);
  res.json({ message: 'Account unlocked' });
}
