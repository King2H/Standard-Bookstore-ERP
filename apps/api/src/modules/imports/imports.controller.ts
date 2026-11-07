import type { Request, Response } from 'express';
import { ImportRequestSchema, type ImportReport, type ImportResult } from '@bms/shared';
import { sendCsv } from '../../lib/csvBuilder.js';
import { valid } from '../../middleware/validate.js';
import type { Actor } from '../catalog/catalog.types.js';
import * as service from './imports.service.js';

/** HTTP side of bulk import and export (#246): validated request -> service -> response. */

export const schemas = {
  file: { body: ImportRequestSchema },
};

function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

const today = () => new Date().toISOString().slice(0, 10);

export function catalogTemplate(_req: Request, res: Response): void {
  sendCsv(res, 'catalog-template.csv', service.catalogTemplate());
}

export async function checkCatalog(req: Request, res: Response): Promise<void> {
  const body: ImportReport = await service.checkCatalog(valid(req, schemas.file).body);
  res.json(body);
}

export async function importCatalog(req: Request, res: Response): Promise<void> {
  const body: ImportResult = await service.importCatalog(actor(req), valid(req, schemas.file).body);
  res.json(body);
}

export async function exportCatalog(_req: Request, res: Response): Promise<void> {
  sendCsv(res, `catalog-${today()}.csv`, await service.exportCatalog());
}
