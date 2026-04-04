import { db } from '../../db/index.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import {
  getEffectiveConfig,
  getMaxLineDiscountPct,
  isNegativeStockAllowed,
  getLoyaltyAccrualRate,
  getLoyaltyMinTransactionAmount,
} from '../config/config.service.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StaffCtx { staffId: number; role: string; branchId: number; }

export interface LineItemInput {
  bookId: number;
  quantity: number;
  discountPct?: number;
}

export interface PaymentInput {
  method: 'cash' | 'bank' | 'store_credit' | 'loyalty_points';
  amount: number;
  reference?: string;
}

export interface TransactionRow {
  id: string;
  branchId: number;
  locationId: number;
  customerId: number | null;
  staffId: number;
  transactionNumber: string;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  amountPaid: number;
  amountDue: number;
  paymentStatus: 'paid' | 'partial' | 'credit';
  currency: string;
  status: 'completed' | 'voided';
  createdAt: string;
  lineItems?: TransactionLineItemRow[];
  payments?: TransactionPaymentRow[];
}

export interface TransactionLineItemRow {
  id: string;
  transactionId: string;
  bookId: number;
  bookTitle: string;
  bookIsbn: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  discountAmount: number;
  lineTotal: number;
}

export interface TransactionPaymentRow {
  id: string;
  transactionId: string;
  method: string;
  amount: number;
  reference: string | null;
  createdAt: string;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function mapTransactionRow(row: Record<string, unknown>): TransactionRow {
  return {
    id: String(row.id),
    branchId: row.branch_id as number,
    locationId: row.location_id as number,
    customerId: (row.customer_id as number | null) ?? null,
    staffId: row.staff_id as number,
    transactionNumber: row.transaction_number as string,
    subtotal: parseFloat(row.subtotal as string),
    discountTotal: parseFloat(row.discount_total as string),
    taxTotal: parseFloat(row.tax_total as string),
    grandTotal: parseFloat(row.grand_total as string),
    amountPaid: parseFloat((row.amount_paid as string) ?? '0'),
    amountDue: parseFloat((row.amount_due as string) ?? '0'),
    paymentStatus: (row.payment_status as 'paid' | 'partial' | 'credit') ?? 'paid',
    currency: row.currency as string,
    status: row.status as 'completed' | 'voided',
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function mapLineItemRow(row: Record<string, unknown>): TransactionLineItemRow {
  return {
    id: String(row.id),
    transactionId: String(row.transaction_id),
    bookId: row.book_id as number,
    bookTitle: (row.book_title as string) ?? '',
    bookIsbn: (row.book_isbn as string) ?? '',
    quantity: row.quantity as number,
    unitPrice: parseFloat(row.unit_price as string),
    discountPct: parseFloat(row.discount_pct as string),
    discountAmount: parseFloat(row.discount_amount as string),
    lineTotal: parseFloat(row.line_total as string),
  };
}

function mapPaymentRow(row: Record<string, unknown>): TransactionPaymentRow {
  return {
    id: String(row.id),
    transactionId: String(row.transaction_id),
    method: row.method as string,
    amount: parseFloat(row.amount as string),
    reference: (row.reference as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchLineItems(txId: string | number): Promise<TransactionLineItemRow[]> {
  const result = await db.query(
    `SELECT li.id, li.transaction_id, li.book_id, b.title AS book_title, b.isbn AS book_isbn,
            li.quantity, li.unit_price, li.discount_pct, li.discount_amount, li.line_total
     FROM transaction_line_items li
     LEFT JOIN books b ON b.id = li.book_id
     WHERE li.transaction_id = $1
     ORDER BY li.id ASC`,
    [txId],
  );
  return result.rows.map(mapLineItemRow);
}

async function fetchPayments(txId: string | number): Promise<TransactionPaymentRow[]> {
  const result = await db.query(
    `SELECT id, transaction_id, method, amount, reference, created_at
     FROM transaction_payments
     WHERE transaction_id = $1
     ORDER BY id ASC`,
    [txId],
  );
  return result.rows.map(mapPaymentRow);
}

// ── getById ───────────────────────────────────────────────────────────────────

export async function getById(id: string | number): Promise<TransactionRow> {
  const result = await db.query(
    `SELECT t.*,
       s.username AS staff_username,
       c.full_name AS customer_name,
       c.customer_code
     FROM transactions t
     LEFT JOIN staff s ON s.id = t.staff_id
     LEFT JOIN customers c ON c.id = t.customer_id
     WHERE t.id = $1`,
    [id],
  );
  if (!result.rows.length) throw new NotFoundError('Transaction');
  const tx = mapTransactionRow(result.rows[0]);
  tx.lineItems = await fetchLineItems(tx.id);
  tx.payments = await fetchPayments(tx.id);
  return tx;
}

// ── list ──────────────────────────────────────────────────────────────────────

export async function list(opts: {
  branchId?: number;
  customerId?: number;
  staffId?: number;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  paymentStatus?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ items: TransactionRow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.branchId)      { params.push(opts.branchId);      conditions.push(`t.branch_id = $${params.length}`); }
  if (opts.customerId)    { params.push(opts.customerId);    conditions.push(`t.customer_id = $${params.length}`); }
  if (opts.staffId)       { params.push(opts.staffId);       conditions.push(`t.staff_id = $${params.length}`); }
  if (opts.status)        { params.push(opts.status);        conditions.push(`t.status = $${params.length}`); }
  if (opts.paymentStatus) { params.push(opts.paymentStatus); conditions.push(`t.payment_status = $${params.length}`); }
  if (opts.dateFrom)      { params.push(opts.dateFrom);      conditions.push(`t.created_at >= $${params.length}`); }
  if (opts.dateTo)        { params.push(opts.dateTo);        conditions.push(`t.created_at <= $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitIdx  = params.length + 1;
  const offsetIdx = params.length + 2;

  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM transactions t ${where}`, params),
    db.query(
      `SELECT t.*
       FROM transactions t
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, pageSize, offset],
    ),
  ]);

  return {
    items: dataRes.rows.map(mapTransactionRow),
    total: parseInt(countRes.rows[0].count as string, 10),
    page,
    totalPages: Math.ceil(parseInt(countRes.rows[0].count as string, 10) / pageSize),
  };
}

// ── createTransaction ─────────────────────────────────────────────────────────
// Supports full payment (paymentStatus='paid'), partial payment (paymentStatus='partial'),
// and zero-payment credit sales (paymentStatus='credit').

export async function createTransaction(
  data: {
    branchId: number;
    locationId: number;
    customerId?: number | null;
    items: LineItemInput[];
    payments: PaymentInput[];
    allowCredit?: boolean; // if true, payment sum < grandTotal is allowed
  },
  staffCtx: StaffCtx,
): Promise<TransactionRow> {
  if (!data.items || data.items.length === 0) throw new ValidationError('At least one item is required');

  // Credit sales require a customer
  if (data.allowCredit && !data.customerId) {
    throw new BusinessError('CREDIT_REQUIRES_CUSTOMER', 'Credit sales require a customer to be selected');
  }

  interface ResolvedItem {
    bookId: number; bookTitle: string; bookIsbn: string;
    quantity: number; unitPrice: number;
    discountPct: number; discountAmount: number; lineTotal: number;
  }
  const resolvedItems: ResolvedItem[] = [];

  for (const item of data.items) {
    const bookRes = await db.query(`SELECT id, title, isbn, is_active FROM books WHERE id = $1`, [item.bookId]);
    if (!bookRes.rows.length) throw new NotFoundError(`Book ${item.bookId}`);
    const book = bookRes.rows[0] as { id: number; title: string; isbn: string; is_active: boolean };
    if (!book.is_active) throw new BusinessError('BOOK_INACTIVE', `Book ${item.bookId} is not active`);

    const priceRes = await db.query(
      `SELECT COALESCE(bbp.price, b.default_price) AS price
       FROM books b
       LEFT JOIN book_branch_prices bbp ON bbp.book_id = b.id AND bbp.branch_id = $2
         AND bbp.format_id = 0 AND bbp.edition_id = 0
       WHERE b.id = $1`,
      [item.bookId, data.branchId],
    );
    const unitPrice = priceRes.rows[0]?.price != null ? parseFloat(priceRes.rows[0].price as string) : null;
    if (unitPrice === null) throw new BusinessError('PRICE_NOT_SET', `Price not set for book ${item.bookId}`);

    const discountPct = item.discountPct ?? 0;
    const discountAmount = parseFloat((unitPrice * item.quantity * (discountPct / 100)).toFixed(2));
    const lineTotal = parseFloat((unitPrice * item.quantity - discountAmount).toFixed(2));
    resolvedItems.push({ bookId: item.bookId, bookTitle: book.title, bookIsbn: book.isbn, quantity: item.quantity, unitPrice, discountPct, discountAmount, lineTotal });
  }

  const maxDiscPct = await getMaxLineDiscountPct(data.branchId, staffCtx.role);
  for (const item of resolvedItems) {
    if (item.discountPct > 0 && item.discountPct > maxDiscPct) {
      throw new BusinessError('DISCOUNT_EXCEEDS_LIMIT', `Discount ${item.discountPct}% exceeds maximum allowed ${maxDiscPct}%`, { maxDiscPct, requested: item.discountPct });
    }
  }

  const subtotal = parseFloat(resolvedItems.reduce((s, i) => s + i.lineTotal, 0).toFixed(2));
  const discountTotal = parseFloat(resolvedItems.reduce((s, i) => s + i.discountAmount, 0).toFixed(2));

  let taxRate = 0.10;
  try { taxRate = Number(await getEffectiveConfig(data.branchId, 'tax_rate')); } catch { /* use default */ }
  const taxTotal = parseFloat((subtotal * taxRate).toFixed(2));
  const grandTotal = parseFloat((subtotal + taxTotal).toFixed(2));

  const payments = data.payments ?? [];
  const amountPaid = parseFloat(payments.reduce((s, p) => s + p.amount, 0).toFixed(2));
  const amountDue = parseFloat((grandTotal - amountPaid).toFixed(2));

  // Validate payment sum — strict for normal sales, relaxed for credit
  if (!data.allowCredit && Math.abs(amountDue) > 0.01) {
    throw new BusinessError('PAYMENT_SUM_MISMATCH', `Payment sum ${amountPaid} does not match grand total ${grandTotal}`, { amountPaid, grandTotal });
  }
  if (amountPaid > grandTotal + 0.01) {
    throw new BusinessError('PAYMENT_EXCEEDS_TOTAL', `Payment ${amountPaid} exceeds grand total ${grandTotal}`);
  }

  // Determine payment status
  let paymentStatus: 'paid' | 'partial' | 'credit';
  if (amountDue <= 0.01) {
    paymentStatus = 'paid';
  } else if (amountPaid > 0.01) {
    paymentStatus = 'partial';
  } else {
    paymentStatus = 'credit';
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Validate customer payment methods (store_credit, loyalty_points)
    if (data.customerId && payments.length > 0) {
      for (const payment of payments) {
        if (payment.method === 'store_credit') {
          const balRes = await client.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1 FOR UPDATE`, [data.customerId]);
          if (!balRes.rows.length || Number(balRes.rows[0].balance) < payment.amount) {
            throw new BusinessError('INSUFFICIENT_STORE_CREDIT', 'Insufficient store credit balance', { available: balRes.rows[0] ? Number(balRes.rows[0].balance) : 0, requested: payment.amount });
          }
        }
        if (payment.method === 'loyalty_points') {
          const balRes = await client.query(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1 FOR UPDATE`, [data.customerId]);
          if (!balRes.rows.length || Number(balRes.rows[0].points_balance) < payment.amount) {
            throw new BusinessError('INSUFFICIENT_LOYALTY_POINTS', 'Insufficient loyalty points balance', { available: balRes.rows[0] ? Number(balRes.rows[0].points_balance) : 0, requested: payment.amount });
          }
        }
      }
    }

    // Inventory check
    interface InvSnapshot { bookId: number; qtyBefore: number; }
    const invSnapshots: InvSnapshot[] = [];
    for (const item of resolvedItems) {
      const invRes = await client.query(`SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE`, [item.bookId, data.locationId]);
      if (!invRes.rows.length) throw new BusinessError('INSUFFICIENT_STOCK', `No inventory record for book ${item.bookId} at location ${data.locationId}`);
      const qtyBefore = invRes.rows[0].quantity as number;
      if (qtyBefore < item.quantity && !(await isNegativeStockAllowed())) {
        throw new BusinessError('INSUFFICIENT_STOCK', `Insufficient stock for book ${item.bookId}. Available: ${qtyBefore}, requested: ${item.quantity}`, { available: qtyBefore, requested: item.quantity });
      }
      invSnapshots.push({ bookId: item.bookId, qtyBefore });
    }

    // Generate transaction number
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const cntRes = await client.query(`SELECT COUNT(*) FROM transactions WHERE DATE(created_at) = CURRENT_DATE`);
    const transactionNumber = `POS-${dateStr}-${String(parseInt(cntRes.rows[0].count as string, 10) + 1).padStart(4, '0')}`;

    // INSERT transaction
    const txRes = await client.query(
      `INSERT INTO transactions (branch_id, location_id, customer_id, staff_id, transaction_number,
         subtotal, discount_total, tax_total, grand_total, amount_paid, amount_due, payment_status, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ETB', 'completed') RETURNING id`,
      [data.branchId, data.locationId, data.customerId ?? null, staffCtx.staffId, transactionNumber,
       subtotal.toFixed(2), discountTotal.toFixed(2), taxTotal.toFixed(2), grandTotal.toFixed(2),
       amountPaid.toFixed(2), amountDue.toFixed(2), paymentStatus],
    );
    const txId: string = String(txRes.rows[0].id);

    // INSERT line items
    for (const item of resolvedItems) {
      await client.query(
        `INSERT INTO transaction_line_items (transaction_id, book_id, quantity, unit_price, discount_pct, discount_amount, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [txId, item.bookId, item.quantity, item.unitPrice.toFixed(2), item.discountPct.toFixed(2), item.discountAmount.toFixed(2), item.lineTotal.toFixed(2)],
      );
    }

    // INSERT payments (only if any)
    for (const payment of payments) {
      await client.query(
        `INSERT INTO transaction_payments (transaction_id, method, amount, reference) VALUES ($1, $2, $3, $4)`,
        [txId, payment.method, payment.amount.toFixed(2), payment.reference ?? null],
      );
    }

    // Decrement inventory
    for (let i = 0; i < resolvedItems.length; i++) {
      const item = resolvedItems[i];
      const { qtyBefore } = invSnapshots[i];
      const qtyAfter = qtyBefore - item.quantity;
      await client.query(`UPDATE inventory SET quantity = quantity - $1, version = version + 1, updated_at = now() WHERE book_id = $2 AND location_id = $3`, [item.quantity, item.bookId, data.locationId]);
      await client.query(
        `INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, reference_type, reference_id, notes, staff_id)
         VALUES ($1, $2, $3, $4, $5, 'stock_out', 'stock_out', 'sale', $6, NULL, $7)`,
        [item.bookId, data.locationId, qtyBefore, qtyAfter, -item.quantity, txId, staffCtx.staffId],
      );
    }

    // Apply customer effects for payments made now
    if (data.customerId && payments.length > 0) {
      for (const payment of payments) {
        if (payment.method === 'store_credit') {
          await client.query(`UPDATE store_credit_accounts SET balance = balance - $1 WHERE customer_id = $2`, [payment.amount, data.customerId]);
          await client.query(`INSERT INTO store_credit_history (customer_id, ref_type, ref_id, amount, direction) VALUES ($1, 'transaction', $2, $3, 'debit')`, [data.customerId, txId, payment.amount]);
        }
        if (payment.method === 'loyalty_points') {
          await client.query(`UPDATE loyalty_accounts SET points_balance = points_balance - $1, updated_at = now() WHERE customer_id = $2`, [payment.amount, data.customerId]);
          await client.query(`INSERT INTO loyalty_history (customer_id, transaction_ref, points_delta, reason) VALUES ($1, $2, $3, 'REDEMPTION')`, [data.customerId, transactionNumber, -payment.amount]);
        }
      }
      // Accrue loyalty on subtotal (only for paid/partial — not pure credit)
      if (paymentStatus !== 'credit') {
        const rate = await getLoyaltyAccrualRate();
        const minAmount = await getLoyaltyMinTransactionAmount();
        if (subtotal >= minAmount) {
          const points = Math.floor(subtotal * rate);
          if (points > 0) {
            await client.query(`UPDATE loyalty_accounts SET points_balance = points_balance + $1, lifetime_points = lifetime_points + $1, updated_at = now() WHERE customer_id = $2`, [points, data.customerId]);
            await client.query(`INSERT INTO loyalty_history (customer_id, transaction_ref, points_delta, reason) VALUES ($1, $2, $3, 'ACCRUAL')`, [data.customerId, transactionNumber, points]);
          }
        }
      }
    }

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1, $2, 'CREATE', 'transaction', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, txId, staffCtx.branchId, JSON.stringify({ transactionNumber, grandTotal, amountPaid, amountDue, paymentStatus, itemCount: resolvedItems.length })],
    );

    await client.query('COMMIT');
    return getById(txId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── recordPayment — collect outstanding balance on a credit/partial transaction ──

export async function recordPayment(
  txId: string | number,
  payments: PaymentInput[],
  staffCtx: StaffCtx,
): Promise<TransactionRow> {
  const tx = await getById(txId);
  if (tx.status === 'voided') throw new BusinessError('TRANSACTION_VOIDED', 'Cannot record payment on a voided transaction');
  if (tx.paymentStatus === 'paid') throw new BusinessError('ALREADY_PAID', 'Transaction is already fully paid');
  if (!payments || payments.length === 0) throw new ValidationError('At least one payment is required');

  const incomingTotal = parseFloat(payments.reduce((s, p) => s + p.amount, 0).toFixed(2));
  if (incomingTotal > tx.amountDue + 0.01) {
    throw new BusinessError('PAYMENT_EXCEEDS_DUE', `Payment ${incomingTotal} exceeds outstanding balance ${tx.amountDue}`, { amountDue: tx.amountDue, incoming: incomingTotal });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Validate customer payment methods
    if (tx.customerId) {
      for (const payment of payments) {
        if (payment.method === 'store_credit') {
          const balRes = await client.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1 FOR UPDATE`, [tx.customerId]);
          if (!balRes.rows.length || Number(balRes.rows[0].balance) < payment.amount) {
            throw new BusinessError('INSUFFICIENT_STORE_CREDIT', 'Insufficient store credit balance');
          }
        }
        if (payment.method === 'loyalty_points') {
          const balRes = await client.query(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1 FOR UPDATE`, [tx.customerId]);
          if (!balRes.rows.length || Number(balRes.rows[0].points_balance) < payment.amount) {
            throw new BusinessError('INSUFFICIENT_LOYALTY_POINTS', 'Insufficient loyalty points balance');
          }
        }
      }
    }

    // INSERT new payments
    for (const payment of payments) {
      await client.query(
        `INSERT INTO transaction_payments (transaction_id, method, amount, reference) VALUES ($1, $2, $3, $4)`,
        [txId, payment.method, payment.amount.toFixed(2), payment.reference ?? null],
      );
    }

    // Recompute totals
    const newAmountPaid = parseFloat((tx.amountPaid + incomingTotal).toFixed(2));
    const newAmountDue = parseFloat((tx.grandTotal - newAmountPaid).toFixed(2));
    const newPaymentStatus: 'paid' | 'partial' | 'credit' = newAmountDue <= 0.01 ? 'paid' : newAmountPaid > 0.01 ? 'partial' : 'credit';

    await client.query(
      `UPDATE transactions SET amount_paid = $1, amount_due = $2, payment_status = $3 WHERE id = $4`,
      [newAmountPaid.toFixed(2), Math.max(0, newAmountDue).toFixed(2), newPaymentStatus, txId],
    );

    // Apply customer effects
    if (tx.customerId) {
      for (const payment of payments) {
        if (payment.method === 'store_credit') {
          await client.query(`UPDATE store_credit_accounts SET balance = balance - $1 WHERE customer_id = $2`, [payment.amount, tx.customerId]);
          await client.query(`INSERT INTO store_credit_history (customer_id, ref_type, ref_id, amount, direction) VALUES ($1, 'payment', $2, $3, 'debit')`, [tx.customerId, String(txId), payment.amount]);
        }
        if (payment.method === 'loyalty_points') {
          await client.query(`UPDATE loyalty_accounts SET points_balance = points_balance - $1, updated_at = now() WHERE customer_id = $2`, [payment.amount, tx.customerId]);
          await client.query(`INSERT INTO loyalty_history (customer_id, transaction_ref, points_delta, reason) VALUES ($1, $2, $3, 'REDEMPTION')`, [tx.customerId, tx.transactionNumber, -payment.amount]);
        }
      }
      // Accrue loyalty when fully settled (tx was partial/credit before this payment)
      if (newPaymentStatus === 'paid') {
        const rate = await getLoyaltyAccrualRate();
        const minAmount = await getLoyaltyMinTransactionAmount();
        if (tx.subtotal >= minAmount) {
          const points = Math.floor(tx.subtotal * rate);
          if (points > 0) {
            await client.query(`UPDATE loyalty_accounts SET points_balance = points_balance + $1, lifetime_points = lifetime_points + $1, updated_at = now() WHERE customer_id = $2`, [points, tx.customerId]);
            await client.query(`INSERT INTO loyalty_history (customer_id, transaction_ref, points_delta, reason) VALUES ($1, $2, $3, 'ACCRUAL')`, [tx.customerId, tx.transactionNumber, points]);
          }
        }
      }
    }

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1, $2, 'UPDATE', 'transaction', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(txId), staffCtx.branchId, JSON.stringify({ action: 'record_payment', incoming: incomingTotal, newAmountDue, newPaymentStatus })],
    );

    await client.query('COMMIT');
    return getById(txId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── voidTransaction ───────────────────────────────────────────────────────────

export async function voidTransaction(id: string | number, staffCtx: StaffCtx): Promise<TransactionRow> {
  const tx = await getById(id);
  if (tx.status === 'voided') throw new BusinessError('ALREADY_VOIDED', 'Transaction is already voided');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    for (const item of tx.lineItems ?? []) {
      const invRes = await client.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE`, [item.bookId, tx.locationId]);
      const qtyBefore = (invRes.rows[0]?.quantity as number) ?? 0;
      const qtyAfter = qtyBefore + item.quantity;
      await client.query(`UPDATE inventory SET quantity = quantity + $1, version = version + 1, updated_at = now() WHERE book_id = $2 AND location_id = $3`, [item.quantity, item.bookId, tx.locationId]);
      await client.query(
        `INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, reference_type, reference_id, notes, staff_id)
         VALUES ($1, $2, $3, $4, $5, 'return', 'stock_in', 'void', $6, NULL, $7)`,
        [item.bookId, tx.locationId, qtyBefore, qtyAfter, item.quantity, String(tx.id), staffCtx.staffId],
      );
    }

    if (tx.customerId) {
      for (const payment of tx.payments ?? []) {
        if (payment.method === 'store_credit') {
          await client.query(`UPDATE store_credit_accounts SET balance = balance + $1 WHERE customer_id = $2`, [payment.amount, tx.customerId]);
          await client.query(`INSERT INTO store_credit_history (customer_id, ref_type, ref_id, amount, direction) VALUES ($1, 'transaction_void', $2, $3, 'credit')`, [tx.customerId, String(tx.id), payment.amount]);
        }
        if (payment.method === 'loyalty_points') {
          await client.query(`UPDATE loyalty_accounts SET points_balance = points_balance + $1, updated_at = now() WHERE customer_id = $2`, [payment.amount, tx.customerId]);
          await client.query(`INSERT INTO loyalty_history (customer_id, transaction_ref, points_delta, reason) VALUES ($1, $2, $3, 'VOID_REVERSAL')`, [tx.customerId, tx.transactionNumber, payment.amount]);
        }
      }
      const accrualRes = await client.query(`SELECT SUM(points_delta) AS total_accrued FROM loyalty_history WHERE customer_id = $1 AND transaction_ref = $2 AND reason = 'ACCRUAL'`, [tx.customerId, tx.transactionNumber]);
      const totalAccrued = Number(accrualRes.rows[0]?.total_accrued ?? 0);
      if (totalAccrued > 0) {
        await client.query(`UPDATE loyalty_accounts SET points_balance = GREATEST(0, points_balance - $1), updated_at = now() WHERE customer_id = $2`, [totalAccrued, tx.customerId]);
        await client.query(`INSERT INTO loyalty_history (customer_id, transaction_ref, points_delta, reason) VALUES ($1, $2, $3, 'VOID_REVERSAL')`, [tx.customerId, tx.transactionNumber, -totalAccrued]);
      }
    }

    await client.query(`UPDATE transactions SET status = 'voided' WHERE id = $1`, [id]);
    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1, $2, 'UPDATE', 'transaction', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(tx.id), staffCtx.branchId, JSON.stringify({ action: 'void', transactionNumber: tx.transactionNumber })],
    );

    await client.query('COMMIT');
    return getById(id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
