import type { ProfileResponse } from '@bms/shared';

/**
 * Who may do what with customers: the API's rules (customer.routes.ts,
 * receivables.routes.ts), so the page offers only what the API accepts. Any
 * role held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Adding customers and changing their details: Admin, Manager and Sales. */
export const canEditCustomers = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Sales']);

/** Deactivating, activating, archiving and restoring: Admin and Manager. */
export const canChangeCustomerStatus = (me: Account | undefined) => holds(me, ['Admin', 'Manager']);

/** Taking points off and adjusting store credit by hand, with a reason: Admin, Manager and Finance_Officer. */
export const canCorrectBalances = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Finance_Officer']);

/** A customer's receivables: the roles that take payments (PROCESS_PAYMENT). */
export const canSeeReceivables = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Finance_Officer', 'Sales']);
