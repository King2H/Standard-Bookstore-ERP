import type { Request, Response } from 'express';
import { AuditLogListQuerySchema, type AuditLogListResponse } from '@bms/shared';
import { scopedBranchOrAll } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toAuditLogResponse } from './audit.mapper.js';
import * as service from './audit.service.js';

/**
 * HTTP side of the Audit module (A3): validated request -> service ->
 * response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: AuditLogListQuerySchema },
};

/**
 * The session branch's entries; staff with access to all branches get every
 * branch, and the entries that belong to no branch, unless they ask for one.
 */
export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.listAuditLogs(
    { branchId: scopedBranchOrAll(req), entityType: query.entityType, staffId: query.staffId },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: AuditLogListResponse = { ...result, items: result.items.map(toAuditLogResponse) };
  res.json(body);
}
