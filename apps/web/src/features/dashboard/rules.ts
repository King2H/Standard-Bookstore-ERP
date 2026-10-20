import type { ProfileResponse } from '@bms/shared';
import { canOpenPage, type Page } from '../../app/navigation.js';

/**
 * Who sees what on the Dashboard: the API's rules for reports (VIEW_REPORTS),
 * by every role held in the session branch (was: the main role, so a Sales
 * and Finance_Officer account with Sales as its main role was turned away).
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Reading the reports the Dashboard is made of. */
export const canReadReports = (me: Account | undefined) => holds(me, ['Super_Admin', 'Admin', 'Manager', 'Finance_Officer']);

/** A date range the API accepts, or what is wrong with it (was: every section failed without a word). */
export function rangeProblem(dateFrom: string, dateTo: string): string | null {
  return dateFrom && dateTo && dateFrom > dateTo ? 'The start date is after the end date' : null;
}

export interface QuickAction { label: string; page: Page; desc: string }

export const QUICK_ACTIONS: QuickAction[] = [
  { label: 'New Sale', page: 'pos', desc: 'Open POS terminal' },
  { label: 'New Purchase', page: 'procurement', desc: 'Create purchase order' },
  { label: 'Add Customer', page: 'customers', desc: 'Register new customer' },
  { label: 'Record Payment', page: 'payments', desc: 'Record order payment' },
];

/** The quick actions whose page the person may open, by the route guard's own rule (was: all four for everyone). */
export function quickActionsFor(userRole: string | null, userRoles: string[], userPermissions: string[]): QuickAction[] {
  return QUICK_ACTIONS.filter((a) => canOpenPage(a.page, userRole, userRoles, userPermissions));
}
