import { db } from '../../db/index.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { getMinDepositPct, getMaxInstallments } from '../config/config.service.js';

export interface StaffCtx { staffId: number; role: string; branchId: number; }

export interface InstallmentPlanRow {
  id: string;
  orderId: string;
  totalAmount: number;
  depositAmount: number;
  numInstallments: number;
  currency: string;
  notes: string | null;
  createdBy: number;
  createdAt: string;
  installments: InstallmentRow[];
}

export interface InstallmentRow {
  id: string;
  planId: string;
  orderId: string;
  dueDate: string;
  amount: number;
  paidAmount: number;
  status: 'pending' | 'partial' | 'paid' | 'overdue';
  paidAt: string | null;
  createdAt: string;
}

function mapPlanRow(row: Record<string, unknown>): Omit<InstallmentPlanRow, 'installments'> {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    totalAmount: parseFloat(row.total_amount as string),
    depositAmount: parseFloat(row.deposit_amount as string),
    numInstallments: row.num_installments as number,
    currency: row.currency as string,
    notes: (row.notes as string | null) ?? null,
    createdBy: row.created_by as number,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function mapInstallmentRow(row: Record<string, unknown>): InstallmentRow {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    orderId: String(row.order_id),
    dueDate: row.due_date instanceof Date
      ? row.due_date.toISOString().split('T')[0]
      : String(row.due_date),
    amount: parseFloat(row.amount as string),
    paidAmount: parseFloat(row.paid_amount as string),
    status: row.status as InstallmentRow['status'],
    paidAt: row.paid_at ? (row.paid_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

async function fetchInstallments(planId: string): Promise<InstallmentRow[]> {
  const res = await db.query(
    'SELECT * FROM installments WHERE plan_id = $1 ORDER BY due_date ASC',
    [planId],
  );
  return res.rows.map(mapInstallmentRow);
}

export async function getPlanById(id: string | number): Promise<InstallmentPlanRow> {
  const res = await db.query('SELECT * FROM installment_plans WHERE id = $1', [id]);
  if (!res.rows.length) throw new NotFoundError('InstallmentPlan');
  const plan = mapPlanRow(res.rows[0]);
  const installments = await fetchInstallments(plan.id);
  return { ...plan, installments };
}

export async function getPlanByOrder(orderId: string | number): Promise<InstallmentPlanRow | null> {
  const res = await db.query('SELECT * FROM installment_plans WHERE order_id = $1', [orderId]);
  if (!res.rows.length) return null;
  const plan = mapPlanRow(res.rows[0]);
  const installments = await fetchInstallments(plan.id);
  return { ...plan, installments };
}

// ── createPlan ────────────────────────────────────────────────────────────────

export async function createPlan(
  data: {
    orderId: number;
    numInstallments: number;
    depositAmount?: number;
    firstDueDate?: string; // ISO date string; defaults to 30 days from now
    notes?: string;
  },
  staffCtx: StaffCtx,
): Promise<InstallmentPlanRow> {
  if (data.numInstallments < 1) throw new ValidationError('numInstallments must be at least 1');

  // Validate order exists
  const orderRes = await db.query('SELECT id, total, status, payment_status FROM orders WHERE id = $1', [data.orderId]);
  if (!orderRes.rows.length) throw new NotFoundError('Order');
  const order = orderRes.rows[0] as Record<string, unknown>;
  if (order.status === 'Cancelled') throw new BusinessError('ORDER_CANCELLED', 'Cannot create installment plan for a cancelled order');
  if (order.payment_status === 'paid') throw new BusinessError('ORDER_ALREADY_PAID', 'Order is already fully paid');

  // Check no existing plan
  const existingPlan = await db.query('SELECT id FROM installment_plans WHERE order_id = $1', [data.orderId]);
  if (existingPlan.rows.length) throw new BusinessError('PLAN_EXISTS', 'An installment plan already exists for this order');

  const orderTotal = parseFloat(order.total as string);

  // Validate against config
  const maxInstallments = await getMaxInstallments();
  if (data.numInstallments > maxInstallments) {
    throw new BusinessError('EXCEEDS_MAX_INSTALLMENTS',
      `Number of installments ${data.numInstallments} exceeds maximum allowed ${maxInstallments}`,
      { requested: data.numInstallments, max: maxInstallments });
  }

  const minDepositPct = await getMinDepositPct(staffCtx.branchId);
  const minDeposit = parseFloat((orderTotal * (minDepositPct / 100)).toFixed(2));
  const depositAmount = data.depositAmount ?? minDeposit;

  if (depositAmount < minDeposit - 0.01) {
    throw new BusinessError('DEPOSIT_TOO_LOW',
      `Deposit ETB ${depositAmount} is below minimum required ETB ${minDeposit} (${minDepositPct}% of order total)`,
      { depositAmount, minDeposit, minDepositPct });
  }

  const remainingAmount = parseFloat((orderTotal - depositAmount).toFixed(2));
  if (remainingAmount < 0) throw new ValidationError('Deposit cannot exceed order total');

  // Compute installment schedule
  const installmentAmount = parseFloat((remainingAmount / data.numInstallments).toFixed(2));
  const firstDue = data.firstDueDate ? new Date(data.firstDueDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const planRes = await client.query(
      `INSERT INTO installment_plans (order_id, total_amount, deposit_amount, num_installments, currency, notes, created_by)
       VALUES ($1, $2, $3, $4, 'ETB', $5, $6) RETURNING id`,
      [data.orderId, orderTotal.toFixed(2), depositAmount.toFixed(2), data.numInstallments, data.notes ?? null, staffCtx.staffId],
    );
    const planId = String(planRes.rows[0].id);

    // Insert installment rows
    for (let i = 0; i < data.numInstallments; i++) {
      const dueDate = new Date(firstDue);
      dueDate.setMonth(dueDate.getMonth() + i);
      // Last installment absorbs rounding difference
      const amount = i === data.numInstallments - 1
        ? parseFloat((remainingAmount - installmentAmount * (data.numInstallments - 1)).toFixed(2))
        : installmentAmount;
      await client.query(
        `INSERT INTO installments (plan_id, order_id, due_date, amount) VALUES ($1, $2, $3, $4)`,
        [planId, data.orderId, dueDate.toISOString().split('T')[0], amount.toFixed(2)],
      );
    }

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'installment_plan', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, planId, staffCtx.branchId,
       JSON.stringify({ orderId: data.orderId, totalAmount: orderTotal, depositAmount, numInstallments: data.numInstallments })],
    );

    await client.query('COMMIT');
    return getPlanById(planId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

// ── recordInstallmentPayment ──────────────────────────────────────────────────

export async function recordInstallmentPayment(
  installmentId: string | number,
  amount: number,
  staffCtx: StaffCtx,
): Promise<InstallmentRow> {
  if (amount <= 0) throw new ValidationError('Payment amount must be positive');

  const res = await db.query('SELECT * FROM installments WHERE id = $1', [installmentId]);
  if (!res.rows.length) throw new NotFoundError('Installment');
  const inst = mapInstallmentRow(res.rows[0]);

  if (inst.status === 'paid') throw new BusinessError('ALREADY_PAID', 'Installment is already fully paid');

  const remaining = parseFloat((inst.amount - inst.paidAmount).toFixed(2));
  if (amount > remaining + 0.01) {
    throw new BusinessError('EXCEEDS_INSTALLMENT_AMOUNT',
      `Payment ETB ${amount} exceeds remaining balance ETB ${remaining}`,
      { remaining, requested: amount });
  }

  const newPaidAmount = parseFloat((inst.paidAmount + amount).toFixed(2));
  const newStatus: InstallmentRow['status'] = newPaidAmount >= inst.amount - 0.01 ? 'paid' : 'partial';
  const paidAt = newStatus === 'paid' ? new Date().toISOString() : null;

  await db.query(
    `UPDATE installments SET paid_amount = $1, status = $2, paid_at = $3 WHERE id = $4`,
    [newPaidAmount.toFixed(2), newStatus, paidAt, installmentId],
  );

  // Update order payment_status based on all installments
  const allRes = await db.query(
    'SELECT status FROM installments WHERE order_id = $1',
    [inst.orderId],
  );
  const allStatuses = allRes.rows.map(r => r.status as string);
  const allPaid = allStatuses.every(s => s === 'paid');
  const anyPaid = allStatuses.some(s => s === 'paid' || s === 'partial');
  const orderPaymentStatus = allPaid ? 'paid' : anyPaid ? 'partial' : 'unpaid';
  await db.query('UPDATE orders SET payment_status = $1, updated_at = now() WHERE id = $2', [orderPaymentStatus, inst.orderId]);

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'installment', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(installmentId), staffCtx.branchId,
     JSON.stringify({ amount, newPaidAmount, newStatus, orderId: inst.orderId })],
  );

  const updated = await db.query('SELECT * FROM installments WHERE id = $1', [installmentId]);
  return mapInstallmentRow(updated.rows[0]);
}
