import type { ProfileResponse, Receivable, ReceivableStatus } from '@bms/shared';

/**
 * Who may do what with receivables: the API's rules (receivables.routes.ts),
 * so the page offers only what the API accepts. Any role held in the session
 * branch counts (was: the main role, for write-off and due dates).
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Collecting, in Payments: the roles that take payments (PROCESS_PAYMENT). */
export const canCollect = (me: Account | undefined) => holds(me, ['Sales', 'Manager', 'Admin', 'Finance_Officer']);

/** Writing off and changing a due date: finance decisions. */
export const canManageReceivables = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Finance_Officer']);

/** The totals are a report (VIEW_REPORTS); Sales read the list only (owner decision 1a). */
export const canSeeSummary = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Finance_Officer']);

/** Still owed: collected, written off or rescheduled. */
export const isOpen = (s: ReceivableStatus) => s === 'Pending' || s === 'PartiallyPaid' || s === 'Overdue';

/** The Dashboard's Outstanding Receivables drill-down, and the filter's own option for it. */
export const OUTSTANDING = 'Pending,PartiallyPaid,Overdue';

/**
 * Where Payments collects it: an order or POS sale by its own id, an exchange
 * difference by the receivable's id (Payments has no exchange row of its own).
 */
export function paymentsContext(r: Pick<Receivable, 'id' | 'sourceType' | 'sourceEntityId'>): Record<string, string> {
  if (r.sourceType === 'exchange_difference') return { orderId: r.id, sourceType: 'exchange_difference' };
  return { orderId: r.sourceEntityId, sourceType: r.sourceType === 'pos_credit_sale' ? 'pos' : 'order' };
}

/** A calendar day (YYYY-MM-DD) as the reader's own day (was: read as UTC midnight, the day before west of UTC). */
export const localDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
