import type { ProfileResponse, PurchaseOrder } from '@bms/shared';

/**
 * Who may do what with a purchase order: the API's rules (procurement.routes.ts,
 * supplierPayables.routes.ts and procurement.policy.ts), so the page offers only
 * what the API accepts. Any role held in the session branch counts. The ordering
 * branch buys, approves, closes and pays; the receiving branch receives (#66,
 * owner decision 1a, #21).
 */
type Account = Pick<ProfileResponse, 'id' | 'currentRoles' | 'currentBranchId'>;
type Order = Pick<PurchaseOrder, 'status' | 'branchId' | 'receivingBranchId' | 'createdBy'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));
const orders = (po: Order, me: Account | undefined) => !!me && po.branchId === me.currentBranchId;
const receives = (po: Order, me: Account | undefined) => !!me && po.receivingBranchId === me.currentBranchId;

/** Writing, submitting, ordering and cancelling: Admin, Manager and Purchasor. */
export const canBuy = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Purchasor']);
const canApprove = (me: Account | undefined) => holds(me, ['Admin', 'Manager']);
const canReceive = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Stock_Clerk']);
const canPay = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Finance_Officer']);
/** The supplier ledger: Admin, Manager, Finance_Officer and Purchasor. */
export const canReadLedger = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Finance_Officer', 'Purchasor']);

const RECEIVABLE = ['approved', 'ordered', 'partially_received'];
const CANCELLABLE = ['draft', 'pending_approval', 'approved', 'ordered'];

/** The steps this staff member may take on this order, in its current status. */
export function stepsFor(po: Order, me: Account | undefined) {
  const buyer = canBuy(me) && orders(po, me);
  return {
    edit: buyer && po.status === 'draft',
    submit: buyer && po.status === 'draft',
    // Nobody approves an order they created.
    approve: canApprove(me) && orders(po, me) && po.status === 'pending_approval' && po.createdBy !== me?.id,
    order: buyer && po.status === 'approved',
    receive: canReceive(me) && receives(po, me) && RECEIVABLE.includes(po.status),
    cancel: buyer && CANCELLABLE.includes(po.status),
    close: canApprove(me) && orders(po, me) && po.status === 'received',
    closeShort: canApprove(me) && orders(po, me) && po.status === 'partially_received',
    pay: canPay(me) && orders(po, me),
  };
}
