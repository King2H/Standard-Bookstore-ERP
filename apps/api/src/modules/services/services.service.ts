import { Money, type ServiceRequest } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { isUniqueViolation } from '../../db/errors.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as policy from './services.policy.js';
import * as services from './services.repository.js';
import type { Actor, LifecycleAction, Paging, ServiceFields, ServiceFilter, ServiceRecord } from './services.types.js';

/**
 * Use cases of the services list (A4, #169): non-stock items a sale carries
 * next to its books. Admin and Manager change it (owner decision 1a); a
 * branch may set its own fee (2a). One function each, owning its transaction.
 */

function audit(q: Queryable, actor: Actor, action: string, id: number, meta: Record<string, unknown>) {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType: 'service',
    entityId: id,
    meta,
  });
}

function found(record: ServiceRecord | undefined): ServiceRecord {
  if (record === undefined) throw new NotFoundError('Service');
  return record;
}

/** The request as stored: the code in capitals, amounts as money. */
async function fieldsOf(q: Queryable, r: ServiceRequest): Promise<ServiceFields> {
  if (!(await services.formatExists(q, r.formatId))) throw new NotFoundError('Book format');
  return {
    code: policy.normalizeCode(r.code),
    name: r.name.trim(),
    kind: r.kind,
    formatId: r.formatId,
    fee: Money.of(r.fee).round(2),
    standardCost: Money.of(r.standardCost).round(2),
    discountable: r.discountable,
    turnaroundDays: r.turnaroundDays,
  };
}

function duplicate(code: string) {
  return (err: unknown): never => {
    if (isUniqueViolation(err)) throw new ConflictError('DUPLICATE_SERVICE', `A service with the code '${code}' already exists`);
    throw err;
  };
}

/** What the audit log keeps of a service's fields. */
function described(s: ServiceFields) {
  return { ...s, fee: s.fee.toFixed(2), standardCost: s.standardCost.toFixed(2) };
}

export function list(branchId: number, filter: ServiceFilter, paging: Paging): Promise<{ items: ServiceRecord[]; total: number }> {
  return services.listServices(kysely, branchId, filter, { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize });
}

export async function getById(id: number, branchId: number): Promise<ServiceRecord> {
  return found(await services.findService(kysely, id, branchId));
}

export async function create(actor: Actor, r: ServiceRequest): Promise<ServiceRecord> {
  return withTransaction({}, async (tx) => {
    const fields = await fieldsOf(tx, r);
    const id = await services.insertService(tx, fields, actor.staffId).catch(duplicate(fields.code));
    await audit(tx, actor, 'CREATE', id, described(fields));
    return found(await services.findService(tx, id, actor.branchId));
  });
}

export async function update(actor: Actor, id: number, r: ServiceRequest): Promise<ServiceRecord> {
  return withTransaction({}, async (tx) => {
    const fields = await fieldsOf(tx, r);
    const before = found(await services.findService(tx, id, actor.branchId));
    await services.updateService(tx, id, fields, actor.staffId).catch(duplicate(fields.code));
    await audit(tx, actor, 'UPDATE', id, {
      ...described(fields),
      before: { code: before.code, name: before.name, fee: before.fee.toFixed(2), standardCost: before.standardCost.toFixed(2) },
    });
    return found(await services.findService(tx, id, actor.branchId));
  });
}

/** Activate, deactivate, archive or restore, by the catalog's lifecycle rule; a repeat changes nothing. */
export async function transition(actor: Actor, id: number, action: LifecycleAction): Promise<ServiceRecord> {
  return withTransaction({}, async (tx) => {
    const current = await services.lockStatus(tx, id);
    if (current === undefined) throw new NotFoundError('Service');
    const next = policy.nextStatus(current, action);
    if (next !== null) {
      await services.setStatus(tx, id, next, actor.staffId);
      await audit(tx, actor, 'UPDATE', id, { action, statusBefore: current, statusAfter: next });
    }
    return found(await services.findService(tx, id, actor.branchId));
  });
}

/** The session branch's own fee (owner decision 2a); the standard cost stays the shop's. */
export async function setBranchFee(actor: Actor, id: number, fee: string | number): Promise<ServiceRecord> {
  return withTransaction({}, async (tx) => {
    const before = found(await services.findService(tx, id, actor.branchId));
    const amount = Money.of(fee).round(2);
    await services.setBranchFee(tx, id, actor.branchId, amount.toFixed(2), actor.staffId);
    await audit(tx, actor, 'UPDATE', id, {
      action: 'branch_fee', branchId: actor.branchId, branchFeeBefore: before.branchFee?.toNumber() ?? null, branchFee: amount.toNumber(),
    });
    return found(await services.findService(tx, id, actor.branchId));
  });
}

/** Back to the shop's fee in the session branch. */
export async function removeBranchFee(actor: Actor, id: number): Promise<ServiceRecord> {
  return withTransaction({}, async (tx) => {
    found(await services.findService(tx, id, actor.branchId));
    const removed = await services.removeBranchFee(tx, id, actor.branchId);
    if (removed !== undefined) {
      await audit(tx, actor, 'UPDATE', id, { action: 'branch_fee', branchId: actor.branchId, branchFeeBefore: Number(removed), branchFee: null });
    }
    return found(await services.findService(tx, id, actor.branchId));
  });
}
