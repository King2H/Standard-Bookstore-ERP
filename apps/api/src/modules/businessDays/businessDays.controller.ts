import type { Request, Response } from 'express';
import {
  BusinessDayListQuerySchema,
  BusinessMonthListQuerySchema,
  CloseDayRequestSchema,
  CloseMonthRequestSchema,
  DayQuerySchema,
  IdParamsSchema,
  MonthQuerySchema,
  ReopenRequestSchema,
  type BusinessDayListResponse,
  type BusinessMonthListResponse,
  type DayPreview,
  type MonthPreview,
} from '@bms/shared';
import { scopedBranch, scopedBranchOrAll } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toBusinessDay, toBusinessDayDetail, toBusinessMonth, toBusinessMonthDetail } from './businessDays.mapper.js';
import * as service from './businessDays.service.js';
import type { Actor } from './businessDays.types.js';

/**
 * HTTP side of closing days and months (A3): validated request -> service ->
 * response. The schemas are the ones the routes pass to validate(). A day is
 * closed in the session's branch; a month for the whole shop.
 */

export const schemas = {
  listDays: { query: BusinessDayListQuerySchema },
  previewDay: { query: DayQuerySchema },
  closeDay: { body: CloseDayRequestSchema },
  byId: { params: IdParamsSchema },
  reopen: { params: IdParamsSchema, body: ReopenRequestSchema },
  listMonths: { query: BusinessMonthListQuerySchema },
  previewMonth: { query: MonthQuerySchema },
  closeMonth: { body: CloseMonthRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, roles, branchId } = req.staff!;
  return { staffId, role, roles: roles?.length ? roles : [role], branchId };
}

export async function listDays(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.listDays);
  const body: BusinessDayListResponse = { items: (await service.listDays(scopedBranchOrAll(req), query)).map(toBusinessDay) };
  res.json(body);
}

export async function previewDay(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.previewDay);
  const body: DayPreview = await service.previewDay(scopedBranch(req), query.day);
  res.json(body);
}

export async function getDay(req: Request, res: Response): Promise<void> {
  res.json(toBusinessDayDetail(await service.getDay(valid(req, schemas.byId).params.id)));
}

export async function closeDay(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.closeDay);
  res.status(201).json(toBusinessDayDetail(await service.closeDay(actor(req), scopedBranch(req), body.day)));
}

export async function reopenDay(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.reopen);
  res.json(toBusinessDayDetail(await service.reopenDay(actor(req), params.id, body.reason)));
}

export async function listMonths(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.listMonths);
  const body: BusinessMonthListResponse = { items: (await service.listMonths(query.year)).map(toBusinessMonth) };
  res.json(body);
}

export async function previewMonth(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.previewMonth);
  const body: MonthPreview = await service.previewMonth(query.month);
  res.json(body);
}

export async function getMonth(req: Request, res: Response): Promise<void> {
  res.json(toBusinessMonthDetail(await service.getMonth(valid(req, schemas.byId).params.id)));
}

export async function closeMonth(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.closeMonth);
  res.status(201).json(toBusinessMonthDetail(await service.closeMonth(actor(req), body.month)));
}

export async function reopenMonth(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.reopen);
  res.json(toBusinessMonthDetail(await service.reopenMonth(actor(req), params.id, body.reason)));
}
