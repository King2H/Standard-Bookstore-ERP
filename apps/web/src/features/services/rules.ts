import type { ProfileResponse } from '@bms/shared';

/**
 * Who may change services: the API's rules (services.routes.ts), so the page
 * offers only what the API accepts. Any role held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

/** Services, their fees and costs, and a branch's own fee: Admin and Manager (owner decision 1a, #169). */
export const canManageServices = (me: Account | undefined) => (me?.currentRoles ?? []).some((r) => r === 'Admin' || r === 'Manager');

/** Cancelling a binding still Requested, its fee given back: Admin and Manager (owner decision 3a, #169 PR 3). */
export const canCancelBinding = canManageServices;

/** An amount in whole cents above zero, as the API takes a fee. */
export const isFee = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim()) && Number(v) > 0;

/** An amount in whole cents, zero or more, as the API takes a cost. */
export const isCost = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim());
