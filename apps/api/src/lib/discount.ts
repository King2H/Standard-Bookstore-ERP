/**
 * Discount Architecture — Shared Utility
 *
 * Pure functions for discount math, validation, and cap enforcement.
 * All service modules import from here — no duplicated formulas.
 *
 * Tax is explicitly excluded: grand total = subtotal − discountTotal.
 */

import { ValidationError, BusinessError } from './errors.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DiscountType = 'Normal' | 'Merchant' | 'Special';
export type DiscountMode = 'Percentage' | 'Amount';

export interface DiscountFields {
  discountType: DiscountType;
  discountMode: DiscountMode;
  /** Percentage 0–100 */
  discountPct: number;
  /** Absolute currency value ≥ 0 */
  discountAmount: number;
}

export interface LineItemBase {
  unitPrice: number;
  quantity: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_DISCOUNT_TYPES: DiscountType[] = ['Normal', 'Merchant', 'Special'];
const VALID_DISCOUNT_MODES: DiscountMode[] = ['Percentage', 'Amount'];

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * Validate a discount type string.
 * Throws ValidationError for values outside ['Normal','Merchant','Special'].
 */
export function validateDiscountType(value: unknown): DiscountType {
  if (typeof value !== 'string' || !VALID_DISCOUNT_TYPES.includes(value as DiscountType)) {
    throw new ValidationError(
      `Invalid discount type '${value}'. Must be one of: ${VALID_DISCOUNT_TYPES.join(', ')}`,
      { received: value, allowed: VALID_DISCOUNT_TYPES },
    );
  }
  return value as DiscountType;
}

/**
 * Validate a discount mode string.
 * Throws ValidationError for values outside ['Percentage','Amount'].
 */
export function validateDiscountMode(value: unknown): DiscountMode {
  if (typeof value !== 'string' || !VALID_DISCOUNT_MODES.includes(value as DiscountMode)) {
    throw new ValidationError(
      `Invalid discount mode '${value}'. Must be one of: ${VALID_DISCOUNT_MODES.join(', ')}`,
      { received: value, allowed: VALID_DISCOUNT_MODES },
    );
  }
  return value as DiscountMode;
}

// ── Math helpers ──────────────────────────────────────────────────────────────

/**
 * Compute discount amount from a percentage.
 * discountAmount = round(unitPrice × quantity × (discountPct / 100), 2)
 */
export function computeAmountFromPct(item: LineItemBase, discountPct: number): number {
  const lineValue = item.unitPrice * item.quantity;
  return Math.round(lineValue * (discountPct / 100) * 100) / 100;
}

/**
 * Compute discount percentage from an amount.
 * discountPct = clamp(round((discountAmount / (unitPrice × quantity)) × 100, 4), 0, 100)
 * Returns 0 when unitPrice × quantity === 0 to avoid division by zero.
 */
export function computePctFromAmount(item: LineItemBase, discountAmount: number): number {
  const lineValue = item.unitPrice * item.quantity;
  if (lineValue === 0) return 0;
  const raw = (discountAmount / lineValue) * 100;
  const rounded = Math.round(raw * 10000) / 10000;
  return Math.min(100, Math.max(0, rounded));
}

/**
 * Compute line total: unitPrice × quantity − discountAmount.
 * No tax component.
 */
export function computeLineTotal(item: LineItemBase, discountAmount: number): number {
  return item.unitPrice * item.quantity - discountAmount;
}

/**
 * Resolve both discount fields from a mode + value pair.
 * Validates that discountAmount ≤ unitPrice × quantity.
 * Throws ValidationError if the constraint is violated.
 */
export function resolveDiscountFields(
  item: LineItemBase,
  mode: DiscountMode,
  value: number,
  type: DiscountType,
): DiscountFields {
  const lineValue = item.unitPrice * item.quantity;
  let discountPct: number;
  let discountAmount: number;

  if (mode === 'Percentage') {
    discountPct = Math.min(100, Math.max(0, value));
    discountAmount = computeAmountFromPct(item, discountPct);
  } else {
    // Amount mode
    discountAmount = Math.max(0, value);
    discountPct = computePctFromAmount(item, discountAmount);
  }

  if (discountAmount > lineValue + 0.001) {
    throw new ValidationError(
      `Discount amount (${discountAmount}) exceeds line value (${lineValue})`,
      { discountAmount, lineValue },
    );
  }

  return { discountType: type, discountMode: mode, discountPct, discountAmount };
}

/**
 * Enforce discount cap.
 * Throws BusinessError('DISCOUNT_EXCEEDS_LIMIT') when discountPct > maxPct.
 */
export function enforceDiscountCap(discountPct: number, maxPct: number): void {
  if (discountPct > maxPct) {
    throw new BusinessError(
      'DISCOUNT_EXCEEDS_LIMIT',
      `Discount of ${discountPct.toFixed(2)}% exceeds the allowed maximum of ${maxPct}%`,
      { discountPct, maxPct },
    );
  }
}
