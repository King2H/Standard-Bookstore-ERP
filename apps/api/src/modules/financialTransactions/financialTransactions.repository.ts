import type { Queryable } from '../../db/tx.js';
import { toFinancialTransactionRecord } from './financialTransactions.mapper.js';
import type { FinancialTransactionFilter, FinancialTransactionRecord } from './financialTransactions.types.js';

// The ledger is branch-owned: every list takes the scoped branch (#12).
// Entries are written by the flows that also update their order or exchange.
// Tenant scope arrives with tenancy (#13).

export async function list(
  q: Queryable,
  filter: FinancialTransactionFilter,
  page: { limit: number; offset: number },
): Promise<{ items: FinancialTransactionRecord[]; total: number }> {
  let query = q.selectFrom('financial_transactions').where('branch_id', '=', filter.branchId);
  if (filter.orderId !== undefined) query = query.where('order_id', '=', String(filter.orderId));
  if (filter.exchangeId !== undefined) query = query.where('exchange_id', '=', String(filter.exchangeId));
  if (filter.type !== undefined) query = query.where('type', '=', filter.type);

  const [rows, count] = await Promise.all([
    query
      .select([
        'id',
        'type',
        'order_id',
        'exchange_id',
        'idempotency_key',
        'amount',
        'currency',
        'method',
        'staff_id',
        'branch_id',
        'meta',
        'created_at',
      ])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toFinancialTransactionRecord), total: Number(count.count) };
}
