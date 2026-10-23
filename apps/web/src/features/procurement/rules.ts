import type { ProfileResponse, PurchaseOrder } from '@bms/shared';

/**
 * Who may do what with a purchase order: the API's rules (procurement.routes.ts,
 * supplierPayables.routes.ts and procurement.policy.ts), so the page offers only
 * what the API accepts. Any role held in the session branch counts. The ordering
 * branch buys, approves, closes and pays; the receiving branch receives (#66,
 * owner decision 1a, #21).
 */
type Account = Pick<ProfileResponse, 'id' | 'currentRoles' | 'currentBranchId'>;
type Order = Pick<PurchaseOrder, 'status' | 'branchId' | 'receivingBranchId'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));
const orders = (po: Order, me: Account | undefined) => !!me && po.branchId === me.currentBranchId;
const receives = (po: Order, me: Account | undefined) => !!me && po.receivingBranchId === me.currentBranchId;

/** Writing, submitting, ordering and cancelling: Admin, Manager and Purchasor. */
export const canBuy = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Purchasor']);
/** Approving and closing: APPROVE_PURCHASE_ORDER, which Admin and Manager hold (owner decision 3a, 2026-10-23). */
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
    // Its creator included, with no reason (owner decision 1a, 2026-10-23).
    approve: canApprove(me) && orders(po, me) && po.status === 'pending_approval',
    order: buyer && po.status === 'approved',
    receive: canReceive(me) && receives(po, me) && RECEIVABLE.includes(po.status),
    cancel: buyer && CANCELLABLE.includes(po.status),
    close: canApprove(me) && orders(po, me) && po.status === 'received',
    closeShort: canApprove(me) && orders(po, me) && po.status === 'partially_received',
    pay: canPay(me) && orders(po, me),
  };
}

type Approval = Pick<PurchaseOrder, 'status' | 'approvalKind' | 'approvalReason' | 'approvedAt' | 'approvalThreshold' | 'currency'>;

/** Where the order's approval stands, in every status (#164): why there is, or is not, an Approve step. */
export function approvalNote(po: Approval): string | null {
  const on = (at: string | null) => (at ? ` on ${new Date(at).toLocaleDateString()}` : '');
  const note = (text: string | null) => (text ? `: ${text}` : '.');
  switch (po.approvalKind) {
    case 'automatic': return `Approved on submit${on(po.approvedAt)}: at or under the approval threshold.`;
    case 'approver': return `Approved by an Admin or Manager other than its creator${on(po.approvedAt)}${note(po.approvalReason)}`;
    case 'creator': return `Approved by its creator${on(po.approvedAt)}${note(po.approvalReason)}`;
    case 'sole_approver': return `Approved by its creator, the only approver of the branch${on(po.approvedAt)}: ${po.approvalReason}`;
  }
  if (po.status === 'draft') {
    return `Approved on submit up to ${po.currency} ${po.approvalThreshold.toFixed(2)}; above that, an Admin or Manager of the branch approves it.`;
  }
  if (po.status === 'pending_approval') {
    return 'Waiting for approval by an Admin or Manager of the branch, its creator included. Super_Admin does not approve purchase orders.';
  }
  return null;
}
