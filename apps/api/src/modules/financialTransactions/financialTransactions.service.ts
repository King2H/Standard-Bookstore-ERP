import { kysely } from '../../db/kysely.js';
import * as ledger from './financialTransactions.repository.js';
import type { FinancialTransactionFilter, FinancialTransactionRecord } from './financialTransactions.types.js';

/** Use cases of the Financial Transactions module (A4): reading the ledger. */

export async function listTransactions(
  filter: FinancialTransactionFilter,
  paging: { page: number; pageSize: number },
): Promise<{ items: FinancialTransactionRecord[]; total: number; page: number; totalPages: number }> {
  const { page, pageSize } = paging;
  const { items, total } = await ledger.list(kysely, filter, { limit: pageSize, offset: (page - 1) * pageSize });
  return { items, total, page, totalPages: Math.ceil(total / pageSize) };
}
