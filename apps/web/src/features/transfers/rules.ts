import type { ProfileResponse, Transfer, TransferLine, TransferOutcome, TransferStatus } from '@bms/shared';

/**
 * Who may do what with a transfer note: the API's rules (transfers.routes.ts,
 * transfers.policy.ts), so the screens offer only what it accepts (#170,
 * owner decisions 2a, 4a). Any role held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** SEND_TRANSFER and RECEIVE_TRANSFER: Admin, Manager and Stock_Clerk. */
export const canTransfer = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Stock_Clerk']);

/** RESOLVE_TRANSFER: Admin and Manager. */
export const canResolve = (me: Account | undefined) => holds(me, ['Admin', 'Manager']);

/** The session branch's side of a note; another branch's note is only read. */
export type Side = 'sending' | 'receiving' | null;

export const sideOf = (t: Pick<Transfer, 'fromBranchId' | 'toBranchId'>, branchId: number | null): Side =>
  t.fromBranchId === branchId ? 'sending' : t.toBranchId === branchId ? 'receiving' : null;

const ON_THE_WAY: TransferStatus[] = ['in_transit', 'partially_received'];

/** A draft is edited, cancelled and dispatched by the sending branch. */
export const canChangeDraft = (t: Pick<Transfer, 'status'>, side: Side, me: Account | undefined) =>
  t.status === 'draft' && side === 'sending' && canTransfer(me);

/** Copies on the way are received by the receiving branch. */
export const canReceive = (t: Pick<Transfer, 'status'>, side: Side, me: Account | undefined) =>
  ON_THE_WAY.includes(t.status) && side === 'receiving' && canTransfer(me);

/** Lost and damaged are the receiving branch's to say; returned, the sending branch's (decision 4a). */
export const outcomesFor = (side: Side): TransferOutcome[] =>
  side === 'receiving' ? ['lost', 'damaged'] : side === 'sending' ? ['returned'] : [];

export const canResolveLine = (t: Pick<Transfer, 'status'>, line: Pick<TransferLine, 'outstandingQuantity'>, side: Side, me: Account | undefined) =>
  ON_THE_WAY.includes(t.status) && line.outstandingQuantity > 0 && side !== null && canResolve(me);

export const STATUS_LABELS: Record<TransferStatus, string> = {
  draft: 'Draft',
  in_transit: 'In transit',
  partially_received: 'Partly received',
  received: 'Received',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export const STATUS_CLASSES: Record<TransferStatus, string> = {
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  in_transit: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  partially_received: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  received: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  closed: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

export const OUTCOME_LABELS: Record<TransferOutcome, string> = {
  lost: 'Lost',
  damaged: 'Damaged',
  returned: 'Returned to us',
};

export const EVENT_LABELS: Record<string, string> = {
  received: 'Received',
  lost: 'Lost',
  damaged: 'Damaged',
  returned: 'Returned',
};
