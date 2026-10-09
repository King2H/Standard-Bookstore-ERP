import type { Request, Response } from 'express';
import {
  BranchLocationParamsSchema,
  BranchLocationsParamsSchema,
  IdParamsSchema,
  LocationNameRequestSchema,
  SetStaffLocationsRequestSchema,
  type Location,
  type LocationListResponse,
  type MessageResponse,
  type StaffLocationListResponse,
} from '@bms/shared';
import { scopeOf } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toLocationResponse, toStaffLocationResponse } from './location.mapper.js';
import * as service from './location.service.js';
import type { Actor } from './location.types.js';

/**
 * HTTP side of the Locations module (A3): validated request -> service ->
 * response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  branch: { params: BranchLocationsParamsSchema },
  create: { params: BranchLocationsParamsSchema, body: LocationNameRequestSchema },
  byId: { params: BranchLocationParamsSchema },
  rename: { params: BranchLocationParamsSchema, body: LocationNameRequestSchema },
  staff: { params: IdParamsSchema },
  setStaff: { params: IdParamsSchema, body: SetStaffLocationsRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId, allBranches: scopeOf(req).allBranches };
}

export async function list(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.branch);
  const { items, accessMode } = await service.listLocations(actor(req), params.branchId);
  const body: LocationListResponse = { items: items.map(toLocationResponse), total: items.length, accessMode };
  res.json(body);
}

export async function create(req: Request, res: Response): Promise<void> {
  const { params, body: dto } = valid(req, schemas.create);
  const body: Location = toLocationResponse(await service.createLocation(actor(req), params.branchId, dto.name));
  res.status(201).json(body);
}

export async function rename(req: Request, res: Response): Promise<void> {
  const { params, body: dto } = valid(req, schemas.rename);
  const body: Location = toLocationResponse(
    await service.renameLocation(actor(req), params.branchId, params.id, dto.name),
  );
  res.json(body);
}

export async function setDefault(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.byId);
  const body: Location = toLocationResponse(await service.setDefaultLocation(actor(req), params.branchId, params.id));
  res.json(body);
}

export async function remove(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.byId);
  await service.deleteLocation(actor(req), params.branchId, params.id);
  const body: MessageResponse = { message: 'Location deleted' };
  res.json(body);
}

export async function listForStaff(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.staff);
  const items = await service.getStaffLocations(actor(req), params.id);
  const body: StaffLocationListResponse = {
    items: items.map(toStaffLocationResponse),
    total: items.length,
    fallbackMode: items.length === 0,
  };
  res.json(body);
}

export async function setForStaff(req: Request, res: Response): Promise<void> {
  const { params, body: locationIds } = valid(req, schemas.setStaff);
  await service.setStaffLocations(actor(req), params.id, locationIds);
  const body: MessageResponse = {
    message:
      locationIds.length === 0
        ? 'Location restrictions cleared — staff now has full branch access'
        : `Location access restricted to ${locationIds.length} location(s)`,
  };
  res.json(body);
}
