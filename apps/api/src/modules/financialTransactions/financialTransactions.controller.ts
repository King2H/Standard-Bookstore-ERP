import type { Request, Response } from 'express';
import { FinancialTransactionListQuerySchema, type FinancialTransactionListResponse } from '@bms/shared';
import { AppError } from '../../lib/errors.js';
import { scopedBranch } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';
import { toFinancialTransactionResponse } from './financialTransactions.mapper.js';
import * as service from './financialTransactions.service.js';

/**
 * HTTP side of the Financial Transactions module (A3): validated request ->
 * service -> response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: FinancialTransactionListQuerySchema },
};

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.listTransactions(
    { branchId: scopedBranch(req), orderId: query.orderId, exchangeId: query.exchangeId, type: query.type },
    { page: query.page, pageSize: query.pageSize },
  );
  const body: FinancialTransactionListResponse = { ...result, items: result.items.map(toFinancialTransactionResponse) };
  res.json(body);
}

/**
 * Retired (#21, owner decision): a ledger entry written by hand never updated
 * its order or exchange. Entries come from the flows that do.
 */
export function create(): never {
  throw new AppError(
    'DEPRECATED',
    'POST /financial-transactions is no longer supported. Payments are recorded through POST /payments, '
      + 'order and receivable collection, and exchange settlement.',
    410,
  );
}
