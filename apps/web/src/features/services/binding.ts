import { Money, type SaleServiceLine, type Service, type ServiceJobStatus, type ServiceJobStep, type ServiceLineInput } from '@bms/shared';

/**
 * A binding asked for on a sale's book line (#169 PR 2), pure: what it adds
 * to the sale and what is sent. The fee is the branch's; a discount only
 * where the service allows it. The API prices the sale again and has the
 * last word.
 */
export interface BindingChoice {
  serviceId: number;
  code: string;
  name: string;
  /** The branch's fee for one copy. */
  unitFee: number;
  discountable: boolean;
  /** Copies to bind: one up to the line's quantity. */
  quantity: number;
  /** 0 to 100; kept at 0 when the fee is not discountable. */
  discountPct: number;
}

export function choiceFor(service: Service, quantity: number): BindingChoice {
  return {
    serviceId: service.id, code: service.code, name: service.name, unitFee: service.effectiveFee,
    discountable: service.discountable, quantity, discountPct: 0,
  };
}

const base = (c: BindingChoice) => Money.of(c.unitFee).times(c.quantity).round(2);

export function bindingDiscount(c: BindingChoice): Money {
  return c.discountable ? base(c).percent(Math.min(100, Math.max(0, c.discountPct))).round(2) : Money.ZERO;
}

export const bindingTotal = (c: BindingChoice) => base(c).minus(bindingDiscount(c));

/** The binding as a sale or order line sends it. */
export function bindingInput(c: BindingChoice): ServiceLineInput {
  return { serviceId: c.serviceId, quantity: c.quantity, ...(c.discountable && c.discountPct > 0 && { discountPct: c.discountPct }) };
}

/** The binding kept to the line's copies when the line's quantity drops. */
export function fitTo(c: BindingChoice | undefined, bookQuantity: number): BindingChoice | undefined {
  return c && { ...c, quantity: Math.min(c.quantity, bookQuantity) };
}

export const JOB_STATUS_LABEL: Record<ServiceJobStatus, string> = {
  REQUESTED: 'Requested',
  AT_BINDER: 'At binder',
  READY: 'Ready',
  COLLECTED: 'Collected',
  CANCELLED: 'Cancelled',
};

/** The one step a job can take next, with its button's label; none once collected or cancelled. */
export function nextStep(status: ServiceJobStatus): { step: ServiceJobStep; label: string } | null {
  if (status === 'REQUESTED') return { step: 'send', label: 'Sent to binder' };
  if (status === 'AT_BINDER') return { step: 'ready', label: 'Back and ready' };
  if (status === 'READY') return { step: 'collect', label: 'Collected' };
  return null;
}

export type { SaleServiceLine };
