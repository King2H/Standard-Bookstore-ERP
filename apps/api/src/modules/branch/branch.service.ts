import { kysely } from '../../db/kysely.js';
import { isUniqueViolation } from '../../db/errors.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as policy from './branch.policy.js';
import * as branches from './branch.repository.js';
import type { Actor, BranchChanges, BranchRecord, NewBranch } from './branch.types.js';

/** Use cases of the Branches module (A4): one function each, owning its transaction. */

function audit(q: Queryable, actor: Actor, action: string, branchId: number, meta: Record<string, unknown>) {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId,
    action,
    entityType: 'branch',
    entityId: branchId,
    meta,
  });
}

function duplicateName(err: unknown, name: string | undefined): never {
  if (isUniqueViolation(err)) {
    throw new ConflictError('DUPLICATE_BRANCH_NAME', `Branch name '${name}' already exists`);
  }
  throw err;
}

export async function getBranch(id: number): Promise<BranchRecord> {
  const branch = await branches.findById(kysely, id);
  if (!branch) throw new NotFoundError('Branch');
  return branch;
}

export async function listBranches(
  filter: { isActive?: boolean },
  paging: { page: number; pageSize: number },
): Promise<{ items: BranchRecord[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const { page, pageSize } = paging;
  const { items, total } = await branches.list(kysely, filter, { limit: pageSize, offset: (page - 1) * pageSize });
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

export async function createBranch(actor: Actor, data: NewBranch): Promise<BranchRecord> {
  policy.checkCanOpenOrClose(actor);
  return withTransaction({}, async (tx) => {
    const branch = await branches.insert(tx, data).catch((err) => duplicateName(err, data.name));
    await audit(tx, actor, 'CREATE', branch.id, { name: branch.name });
    return branch;
  });
}

export async function updateBranch(actor: Actor, id: number, changes: BranchChanges): Promise<BranchRecord> {
  policy.checkCanEditDetails(actor, id);
  return withTransaction({}, async (tx) => {
    const branch = await branches.update(tx, id, changes).catch((err) => duplicateName(err, changes.name));
    if (!branch) throw new NotFoundError('Branch');
    await audit(tx, actor, 'UPDATE', id, changes);
    return branch;
  });
}

async function setActive(actor: Actor, id: number, isActive: boolean): Promise<void> {
  policy.checkCanOpenOrClose(actor);
  await withTransaction({}, async (tx) => {
    if (!(await branches.setActive(tx, id, isActive))) throw new NotFoundError('Branch');
    await audit(tx, actor, isActive ? 'REACTIVATE' : 'DEACTIVATE', id, { id });
  });
}

export function deactivateBranch(actor: Actor, id: number): Promise<void> {
  return setActive(actor, id, false);
}

export function reactivateBranch(actor: Actor, id: number): Promise<void> {
  return setActive(actor, id, true);
}

export async function deleteBranch(actor: Actor, id: number): Promise<void> {
  policy.checkCanOpenOrClose(actor);
  await withTransaction({}, async (tx) => {
    policy.checkDeletable(await branches.dependenciesOf(tx, id));
    if (!(await branches.remove(tx, id))) throw new NotFoundError('Branch');
    await audit(tx, actor, 'DELETE', id, { id });
  });
}
