import type { Request, Response } from 'express';
import {
  BranchConfigKeyParamsSchema,
  BranchConfigParamsSchema,
  ConfigKeyParamsSchema,
  EffectiveConfigQuerySchema,
  SetConfigValueRequestSchema,
  type BranchConfigListResponse,
  type ConfigEntry,
  type CurrencyResponse,
  type EffectiveConfigResponse,
  type MessageResponse,
  type SystemConfigListResponse,
} from '@bms/shared';
import { valid } from '../../middleware/validate.js';
import { toConfigEntryResponse, toEffectiveConfigEntryResponse } from './config.mapper.js';
import * as service from './config.service.js';
import type { Actor } from './config.types.js';

/**
 * HTTP side of the Configuration module (A3): validated request -> service ->
 * response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  effective: { query: EffectiveConfigQuerySchema },
  setSystem: { params: ConfigKeyParamsSchema, body: SetConfigValueRequestSchema },
  branch: { params: BranchConfigParamsSchema },
  setBranch: { params: BranchConfigKeyParamsSchema, body: SetConfigValueRequestSchema },
  removeBranch: { params: BranchConfigKeyParamsSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

export async function listSystem(_req: Request, res: Response): Promise<void> {
  const items = (await service.listSystemConfig()).map(toConfigEntryResponse);
  const body: SystemConfigListResponse = { items, total: items.length };
  res.json(body);
}

export async function currency(req: Request, res: Response): Promise<void> {
  const body: CurrencyResponse = { currency: await service.getBaseCurrency(actor(req).branchId) };
  res.json(body);
}

export async function effective(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.effective);
  const body: EffectiveConfigResponse = { items: await service.getEffectiveValues(actor(req).branchId, query.keys) };
  res.json(body);
}

export async function setSystem(req: Request, res: Response): Promise<void> {
  const { params, body: dto } = valid(req, schemas.setSystem);
  const body: ConfigEntry = toConfigEntryResponse(await service.setSystemConfig(actor(req), params.key, dto.value));
  res.json(body);
}

export async function listBranch(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.branch);
  const items = (await service.getEffectiveBranchConfig(params.branchId)).map(toEffectiveConfigEntryResponse);
  const body: BranchConfigListResponse = { items, total: items.length };
  res.json(body);
}

export async function setBranch(req: Request, res: Response): Promise<void> {
  const { params, body: dto } = valid(req, schemas.setBranch);
  const record = await service.setBranchConfig(actor(req), params.branchId, params.key, dto.value);
  const body: ConfigEntry = toConfigEntryResponse(record);
  res.json(body);
}

export async function removeBranch(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.removeBranch);
  await service.deleteBranchConfig(actor(req), params.branchId, params.key);
  const body: MessageResponse = {
    message: `Branch override for '${params.key}' removed; system default now applies`,
  };
  res.json(body);
}
