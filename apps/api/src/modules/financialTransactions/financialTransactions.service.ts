import { db } from '../../db/index.js';
import { BusinessError, ConflictError } from '../../lib/errors.js';

export interface StaffCtx { staffId: number; role: string; branchId: number; }

export interface FinancialTransaction {
  id: string;
  type: 'payment' | 'refund' | 'adjustment';
  orderId: string | null;
  exchangeId: string | null;
  idempotencyKey: string;
  amount: number;
  currency: string;
  method: string | null;
  staffId: number;
  branchId: number;
  meta: Record<string, unknown>;
  createdAt: string;
}

function mapRow(row: Record<string, unknown>): FinancialTransaction {
  return {
    id: String(row.id),
    type: row.type as 'payment' | 'refund' | 'adjustment',
    orderId: row.order_id != null ? String(row.order_id) : null,
    exchangeId: row.exchange_id != null ? String(row.exchange_id) : null,
    idempotencyKey: row.idempotency_key as string,
    amount: parseFloat(row.amount as string),
    currency: row.currency as string,
    method: (row.method as string | null) ?? null,
    staffId: row.staff_id as number,
    branchId: row.branch_id as number,
    meta: (row.meta as Record<string, unknown>) ?? {},
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export async function createTransaction(
  data: {
    type: 'payment' | 'refund' | 'adjustment';
    orderId?: number | null;
    exchangeId?: number | null;
    idempotencyKey: string;
    amount: number;
    currency?: string;
    method?: string | null;
    meta?: Record<string, unknown>;
  },
  staffCtx: StaffCtx,
): Promise<{ transaction: FinancialTransaction; replayed: boolean }> {
  // Enforce: must reference order or exchange
  if (!data.orderId && !data.exchangeId) {
    throw new BusinessError(
      'MISSING_TRANSACTION_REFERENCE',
      'Transaction must reference either an order_id or exchange_id',
    );
  }

  // Idempotency check
  const existing = await db.query(
    `SELECT * FROM financial_transactions WHERE idempotency_key = $1`,
    [data.idempotencyKey],
  );
  if (existing.rows.length > 0) {
    const ex = existing.rows[0];
    const sameOrder    = (ex.order_id    == null ? null : String(ex.order_id))    === (data.orderId    == null ? null : String(data.orderId));
    const sameExchange = (ex.exchange_id == null ? null : String(ex.exchange_id)) === (data.exchangeId == null ? null : String(data.exchangeId));
    const sameAmount   = Math.abs(parseFloat(ex.amount as string) - data.amount) < 0.01;
    if (!sameOrder || !sameExchange || !sameAmount) {
      throw new ConflictError('IDEMPOTENCY_CONFLICT', 'Idempotency key already used with different parameters');
    }
    return { transaction: mapRow(ex), replayed: true };
  }

  const result = await db.query(
    `INSERT INTO financial_transactions
       (type, order_id, exchange_id, idempotency_key, amount, currency, method, staff_id, branch_id, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      data.type,
      data.orderId    ?? null,
      data.exchangeId ?? null,
      data.idempotencyKey,
      data.amount.toFixed(2),
      data.currency ?? 'ETB',
      data.method   ?? null,
      staffCtx.staffId,
      staffCtx.branchId,
      JSON.stringify(data.meta ?? {}),
    ],
  );

  return { transaction: mapRow(result.rows[0]), replayed: false };
}

export async function listTransactions(opts: {
  orderId?:    number;
  exchangeId?: number;
  type?:       string;
  branchId?:   number;
  page?:       number;
  pageSize?:   number;
}): Promise<{ items: FinancialTransaction[]; total: number; page: number; totalPages: number }> {
  const page     = Math.max(1, opts.page     ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset   = (page - 1) * pageSize;
  const conditions: string[] = [];
  const params: unknown[]    = [];

  if (opts.orderId)    { params.push(opts.orderId);    conditions.push('order_id = $'    + params.length); }
  if (opts.exchangeId) { params.push(opts.exchangeId); conditions.push('exchange_id = $' + params.length); }
  if (opts.type)       { params.push(opts.type);       conditions.push('type = $'        + params.length); }
  if (opts.branchId)   { params.push(opts.branchId);   conditions.push('branch_id = $'   + params.length); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const li = params.length + 1;
  const oi = params.length + 2;

  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM financial_transactions ${where}`, params),
    db.query(`SELECT * FROM financial_transactions ${where} ORDER BY created_at DESC LIMIT $${li} OFFSET $${oi}`, [...params, pageSize, offset]),
  ]);

  return {
    items:      dataRes.rows.map(mapRow),
    total:      parseInt(countRes.rows[0].count as string, 10),
    page,
    totalPages: Math.ceil(parseInt(countRes.rows[0].count as string, 10) / pageSize),
  };
}
