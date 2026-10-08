import { Money } from '@bms/shared';
import { BusinessError, ValidationError } from '../../lib/errors.js';
import { resolveDiscountFields, enforceDiscountCap, type DiscountMode, type DiscountType } from '../../lib/discount.js';
import type { Permission } from '../../lib/permissions.js';
import type { OrderLineInput, OrderTotals, PricedLine, SaleType } from './orders.types.js';

/**
 * Order rules as pure functions (A5): the lifecycle, pricing and settlement
 * arithmetic. No I/O, so they are unit-tested without a database
 * (__tests__/orders.policy.test.ts).
 */

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Rows written before migration 33 may still hold the legacy status names.
const LEGACY_TO_NEW: Record<string, string> = {
  Pending:     'DRAFT',
  Confirmed:   'CONFIRMED',
  In_Progress: 'CONFIRMED',
  Fulfilled:   'FULFILLED',
  Cancelled:   'CANCELLED',
};

/** Normalise any status value to the new lifecycle format for business logic. */
export function normaliseStatus(status: string): string {
  return LEGACY_TO_NEW[status] ?? status;
}

function invalidState(verb: string, status: string): BusinessError {
  return new BusinessError('INVALID_STATE', `Cannot ${verb} order in status '${status}'`);
}

export function checkCanConfirm(status: string): void {
  if (normaliseStatus(status) !== 'DRAFT') throw invalidState('confirm', status);
}

/** Legacy transition (#69): CONFIRMED -> PAID. */
export function checkCanPay(status: string): void {
  if (!['CONFIRMED', 'Confirmed', 'In_Progress'].includes(status)) throw invalidState('pay', status);
}

/** Legacy transition (#69): only the pre-migration-33 status 'Confirmed'. */
export function checkCanProgress(status: string): void {
  if (status !== 'Confirmed') throw invalidState('progress', status);
}

/**
 * Fulfilment is a logistics event, not a payment event: any confirmed order
 * may be fulfilled, whatever its sale type or payment status. A credit sale's
 * payment follows delivery.
 */
export function checkCanFulfill(status: string): void {
  const allowed = ['CONFIRMED', 'PARTIALLY_PAID', 'PAID', 'Confirmed', 'In_Progress'].includes(status);
  if (!allowed && normaliseStatus(status) !== 'CONFIRMED') {
    throw new BusinessError('INVALID_STATE', `Cannot fulfill order in status '${status}'`);
  }
}

/**
 * Cancelling is refused after fulfilment (that is a return). Returns whether
 * confirm() already took the stock out, so the cancellation must put it back.
 */
export function checkCanCancel(status: string): { restoresStock: boolean } {
  const ns = normaliseStatus(status);
  if (['FULFILLED', 'COMPLETED'].includes(ns)) {
    throw new BusinessError('ORDER_ALREADY_FULFILLED', 'Cannot cancel a fulfilled or completed order. Use the Return module for post-fulfillment reversals.');
  }
  if (ns === 'CANCELLED') throw new BusinessError('ALREADY_CANCELLED', 'Order is already cancelled');
  return { restoresStock: ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'].includes(ns) };
}

/**
 * Only orders that never moved stock or money may be deleted: DRAFT or
 * CANCELLED, and then only without any recorded history.
 */
export function checkCanDelete(order: { status: string; orderNumber: string }, blockers: string[]): void {
  const ns = normaliseStatus(order.status);
  if (ns !== 'DRAFT' && ns !== 'CANCELLED') {
    throw new BusinessError(
      'INVALID_STATE',
      `Cannot delete order in status '${order.status}'. Only Draft or Cancelled orders can be deleted — cancel it first.`,
    );
  }
  if (blockers.length) {
    throw new BusinessError(
      'ORDER_HAS_DEPENDENCIES',
      `Cannot delete order ${order.orderNumber}: it has ${blockers.join(', ')} on record. Orders with financial or inventory history must be retained.`,
      { blockers },
    );
  }
}

export function checkPaymentAmount(amount: number): void {
  if (amount <= 0) throw new ValidationError('paymentAmount must be positive');
}

/** Credit orders collect payment after delivery; a cancelled order's finances are frozen. */
export function checkCanCollectPayment(order: { status: string; saleType: SaleType }): void {
  const ns = normaliseStatus(order.status);
  if (ns === 'CANCELLED') {
    throw new BusinessError('ORDER_CANCELLED', 'Cannot collect payment on a cancelled order. Financial lifecycle is frozen.');
  }
  if (!['FULFILLED', 'COMPLETED'].includes(ns)) {
    throw new BusinessError('INVALID_STATE', `Cannot collect payment for order in status '${order.status}'. Order must be FULFILLED or COMPLETED.`);
  }
  if (order.saleType !== 'credit_sale') {
    throw new BusinessError('INVALID_STATE', 'collectPayment is only valid for credit_sale orders');
  }
}

/**
 * The actions the UI may offer for an order, by status and the staff member's
 * permissions. `_paymentStatus` and `_saleType` are kept for the existing
 * callers; no rule reads them since payment collection moved to Payments.
 */
export function computeOrderAllowedActions(
  status: string,
  permissions: Permission[],
  _paymentStatus?: string,
  _saleType?: SaleType,
): string[] {
  const can = (p: Permission) => permissions.includes(p);
  const cancelOrFulfill = [...(can('CREATE_SALE') ? ['cancel'] : []), ...(can('PROCESS_PAYMENT') ? ['fulfill'] : [])];

  switch (status) {
    case 'DRAFT':
    case 'Pending':
      return can('CREATE_SALE') ? ['confirm', 'cancel'] : [];
    case 'CONFIRMED':
    case 'PARTIALLY_PAID':
    case 'Confirmed':
    case 'In_Progress':
      return cancelOrFulfill;
    case 'PAID':
      return can('PROCESS_PAYMENT') ? ['fulfill'] : [];
    case 'FULFILLED':
      return ['return'];
    case 'COMPLETED':
    case 'Fulfilled':
      return ['print'];
    default:
      return [];
  }
}

// ── Creating an order ────────────────────────────────────────────────────────

export function checkNewOrder(data: { saleType: SaleType; customerId?: number | null; items: OrderLineInput[] }): void {
  if (!data.items || data.items.length === 0) throw new ValidationError('At least one item is required');
  if (data.saleType === 'credit_sale' && !data.customerId) {
    throw new BusinessError('CREDIT_REQUIRES_CUSTOMER', 'Credit sales require a customer to be selected');
  }
}

export function checkQuantity(item: OrderLineInput): void {
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
    throw new ValidationError(`Quantity for book ${item.bookId} must be a positive integer`);
  }
}

/**
 * Prices one line at `unitPrice`. With discount mode/type/percentage fields the
 * shared discount engine applies, capped at `maxDiscountPct`; otherwise the
 * legacy plain discountAmount, never negative.
 */
export function priceLine(item: OrderLineInput, unitPrice: number, maxDiscountPct: number): PricedLine {
  let discount: { discountPct: number; discountAmount: Money; discountType: DiscountType; discountMode: DiscountMode };

  if (item.discountMode != null || item.discountType != null || item.discountPct != null) {
    const mode: DiscountMode = item.discountMode ?? 'Percentage';
    const type: DiscountType = item.discountType ?? 'Normal';
    const value = mode === 'Amount' ? (item.discountAmount ?? 0) : (item.discountPct ?? 0);
    const resolved = resolveDiscountFields({ unitPrice, quantity: item.quantity }, mode, value, type);
    enforceDiscountCap(resolved.discountPct, maxDiscountPct);
    discount = { ...resolved, discountAmount: Money.of(resolved.discountAmount) };
  } else {
    const discountAmount = Money.max(0, Money.of(item.discountAmount ?? 0).round(2));
    const lineValue = unitPrice * item.quantity;
    const discountPct = lineValue > 0 ? Math.round((discountAmount.toNumber() / lineValue) * 10000) / 100 : 0;
    discount = { discountAmount, discountPct, discountType: 'Normal', discountMode: 'Amount' };
  }

  const totalPrice = Money.of(unitPrice).times(item.quantity).minus(discount.discountAmount);
  return {
    bookId: item.bookId,
    quantity: item.quantity,
    unitPrice: Money.of(unitPrice).toFixed(2),
    discountAmount: discount.discountAmount.toFixed(2),
    discountPct: discount.discountPct,
    discountType: discount.discountType,
    discountMode: discount.discountMode,
    totalPrice: totalPrice.toFixed(2),
  };
}

/** Order totals from its priced lines. Tax is not charged yet (ADR-0010: default 0%). */
export function orderTotals(lines: PricedLine[]): OrderTotals {
  const subtotal = Money.sum(lines.map((l) => l.totalPrice));
  return {
    subtotal: subtotal.toFixed(2),
    discountTotal: Money.sum(lines.map((l) => l.discountAmount)).toFixed(2),
    taxRate: '0.0000',
    taxAmount: '0.00',
    total: subtotal.toFixed(2),
  };
}

/** `PREFIX-YYYYMMDD-NNNN` from the count of today's records (see #68). */
export function dailyNumber(prefix: string, dateStr: string, countToday: number): string {
  return `${prefix}-${dateStr}-${String(countToday + 1).padStart(4, '0')}`;
}

// ── Confirming an order ──────────────────────────────────────────────────────

export const CASH_PAYMENT_METHODS = ['cash', 'bank', 'mobile', 'store_credit'] as const;

/**
 * A credit order needs a due date on the receivable it creates, today or
 * later. Dates are compared as YYYY-MM-DD strings against the database's own
 * date, so the server's time zone never shifts them.
 */
export function checkDueDate(order: { saleType: SaleType; customerId: number | null }, dueDate: string | null | undefined, today: string): void {
  if (order.saleType !== 'credit_sale' || !order.customerId) return;
  if (!dueDate) throw new ValidationError('due_date is required to confirm a credit sale order');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new ValidationError('due_date must be in YYYY-MM-DD format');
  if (dueDate < today) throw new ValidationError(`due_date must be today (${today}) or later`);
}

/**
 * A cash order is paid at confirmation, so it always records a payment
 * method: the one chosen, or cash. Credit orders record none.
 */
export function confirmPaymentMethod(
  order: { saleType: SaleType; customerId: number | null },
  paymentMethod: string | null | undefined,
): string | null {
  if (order.saleType !== 'cash_sale') return null;
  const method = paymentMethod || 'cash';
  if (!(CASH_PAYMENT_METHODS as readonly string[]).includes(method)) {
    throw new ValidationError(`payment_method must be one of: ${CASH_PAYMENT_METHODS.join(', ')}`);
  }
  if (method === 'store_credit' && !order.customerId) {
    throw new BusinessError('STORE_CREDIT_REQUIRES_CUSTOMER', 'Store credit payment requires a customer to be selected');
  }
  return method;
}

/** Store credit must cover the order total (a 0.01 tolerance, as before). */
export function checkStoreCredit(balance: string | null, total: number): void {
  const available = Money.of(balance ?? 0);
  if (available.lessThan(Money.of(total).minus('0.01'))) {
    throw new BusinessError(
      'INSUFFICIENT_STORE_CREDIT',
      `Insufficient store credit. Available: ETB ${available.toFixed(2)}, requested: ETB ${Money.of(total).toFixed(2)}`,
      { available: available.toNumber(), requested: total },
    );
  }
}

/** What a credit order still owes after what was already paid; null when nothing (within 0.01). */
export function amountToInvoice(total: number, alreadyPaid: string): Money | null {
  const outstanding = Money.of(total).minus(alreadyPaid).round(2);
  return outstanding.greaterThan('0.01') ? outstanding : null;
}

/** A payment against a credit order's receivable; never below zero. */
export function applyPayment(currentOutstanding: string, amount: number): { newOutstanding: Money; isFullySettled: boolean } {
  const newOutstanding = Money.max(0, Money.of(currentOutstanding).minus(amount));
  return { newOutstanding, isFullySettled: newOutstanding.isZero() };
}
