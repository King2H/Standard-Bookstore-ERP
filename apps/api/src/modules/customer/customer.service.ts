import type { CreateCustomerRequest, MoneyInput, UpdateCustomerRequest } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { transitionEntityStatus } from '../../lib/lifecycle.js';
import { insertOutbox } from '../../lib/outbox.js';
import { encryptPii, piiLookupHash } from '../../lib/piiEncryption.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { getLoyaltyAccrualRate, getLoyaltyMinTransactionAmount } from '../config/config.service.js';
import * as policy from './customer.policy.js';
import * as customers from './customer.repository.js';
import type {
  Actor,
  CustomerFilter,
  CustomerGroupRecord,
  CustomerRecord,
  LoyaltyHistoryRecord,
  StoreCreditHistoryRecord,
  StoredContact,
} from './customer.types.js';

/**
 * Use cases of the Customers module (A4): one function each, owning its
 * transaction. Customers are shared by every branch.
 */

type Paged<T> = { items: T[]; total: number; page: number; totalPages: number };

function paged<T>(result: { items: T[]; total: number }, page: number, pageSize: number): Paged<T> {
  return { ...result, page, totalPages: Math.ceil(result.total / pageSize) };
}

function audit(q: Queryable, actor: Actor, action: string, entityType: string, entityId: number, meta: Record<string, unknown>) {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType,
    entityId,
    meta,
  });
}

/** How a phone or email is stored: plain (until #90), encrypted, and as a lookup hash. */
function stored(value: string | null | undefined): StoredContact {
  const plain = value?.trim() || null;
  return { plain, encrypted: encryptPii(plain), lookup: piiLookupHash(plain) };
}

async function checkContactFree(q: Queryable, field: 'phone' | 'email', contact: StoredContact, exceptId?: number) {
  if (!contact.plain) return;
  if (await customers.findContactOwner(q, field, { plain: contact.plain, lookup: contact.lookup }, exceptId)) {
    throw new ConflictError('DUPLICATE_CONTACT', `${field === 'phone' ? 'Phone number' : 'Email address'} already in use`, {
      field,
    });
  }
}

async function getOrThrow(q: Queryable, id: number): Promise<CustomerRecord> {
  const customer = await customers.findById(q, id);
  if (!customer) throw new NotFoundError('Customer');
  return customer;
}

async function requireCustomer(q: Queryable, id: number) {
  const customer = await customers.exists(q, id);
  if (!customer) throw new NotFoundError('Customer');
  return customer;
}

// ── Customers ─────────────────────────────────────────────────────────────────

export function getCustomerById(id: number): Promise<CustomerRecord> {
  return getOrThrow(kysely, id);
}

export async function searchCustomers(
  filter: CustomerFilter,
  paging: { page: number; pageSize: number },
): Promise<Paged<CustomerRecord>> {
  const q = filter.q?.trim() || undefined;
  const result = await customers.list(
    kysely,
    { ...filter, q, qLookup: piiLookupHash(q) },
    { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize },
  );
  return paged(result, paging.page, paging.pageSize);
}

export async function createCustomer(actor: Actor, dto: CreateCustomerRequest): Promise<CustomerRecord> {
  const phone = stored(dto.phone);
  const email = stored(dto.email);

  return withTransaction({}, async (tx) => {
    await checkContactFree(tx, 'phone', phone);
    await checkContactFree(tx, 'email', email);
    const customerCode = policy.nextCustomerCode(await customers.highestCustomerNumber(tx));
    const id = await customers.insert(tx, {
      branchId: dto.branchId ?? null,
      customerCode,
      fullName: dto.fullName,
      phone,
      email,
      gender: dto.gender ?? null,
      dateOfBirth: dto.dateOfBirth ?? null,
      address: dto.address ?? null,
      city: dto.city ?? null,
      createdBy: actor.staffId,
    });
    await audit(tx, actor, 'CREATE', 'customer', id, { customerCode, fullName: dto.fullName });
    return getOrThrow(tx, id);
  });
}

export async function updateCustomer(actor: Actor, id: number, dto: UpdateCustomerRequest): Promise<CustomerRecord> {
  return withTransaction({}, async (tx) => {
    await requireCustomer(tx, id);
    const phone = dto.phone !== undefined ? stored(dto.phone) : undefined;
    const email = dto.email !== undefined ? stored(dto.email) : undefined;
    if (phone) await checkContactFree(tx, 'phone', phone, id);
    if (email) await checkContactFree(tx, 'email', email, id);

    await customers.update(tx, id, {
      fullName: dto.fullName,
      phone,
      email,
      gender: dto.gender,
      dateOfBirth: dto.dateOfBirth,
      address: dto.address,
      city: dto.city,
      branchId: dto.branchId,
      updatedBy: actor.staffId,
    });
    // Field names only: phone and email must not reach the audit log in plain text (#90).
    await audit(tx, actor, 'UPDATE', 'customer', id, { fields: Object.keys(dto) });
    return getOrThrow(tx, id);
  });
}

export async function deactivateCustomer(actor: Actor, id: number): Promise<void> {
  const customer = await requireCustomer(kysely, id);
  // The shared lifecycle helper keeps is_active in step with status and
  // writes the audit entry; it moves to a repository with Catalog (#21).
  await transitionEntityStatus('customers', 'customer', id, 'INACTIVATE', actor, { syncIsActive: true });
  await withTransaction({}, (_tx, client) =>
    insertOutbox(client, 'customer.deactivated', {
      customerId: id,
      customerName: customer.fullName,
      customerCode: customer.customerCode,
      branchId: customer.branchId ?? actor.branchId,
    }),
  ).catch(() => undefined); // a notification never blocks the change
}

// ── Loyalty ───────────────────────────────────────────────────────────────────

export async function getLoyaltyHistory(
  customerId: number,
  paging: { page: number; pageSize: number },
): Promise<Paged<LoyaltyHistoryRecord>> {
  const result = await customers.loyaltyHistory(kysely, customerId, {
    limit: paging.pageSize,
    offset: (paging.page - 1) * paging.pageSize,
  });
  return paged(result, paging.page, paging.pageSize);
}

/** Points earned on a sale (outbox workers and POS); nothing below the configured minimum. */
export async function accruePoints(customerId: number, amount: MoneyInput, transactionRef: string | null): Promise<void> {
  const points = policy.pointsEarned(amount, await getLoyaltyAccrualRate(), await getLoyaltyMinTransactionAmount());
  if (points <= 0) return;
  await withTransaction({}, (tx) => customers.addPoints(tx, customerId, points, { reason: 'ACCRUAL', transactionRef }));
}

/** A back-office correction with a reason; customers spend points as a payment at checkout. */
export async function redeemPoints(
  actor: Actor,
  customerId: number,
  redemption: { points: number; reason: string; transactionRef: string | null },
): Promise<void> {
  await withTransaction({}, async (tx) => {
    await requireCustomer(tx, customerId);
    const balance = await customers.lockPoints(tx, customerId);
    if (balance === undefined) throw new NotFoundError('Loyalty account');
    policy.checkEnoughPoints(balance, redemption.points);

    await customers.addPoints(tx, customerId, -redemption.points, {
      reason: 'REDEMPTION',
      transactionRef: redemption.transactionRef,
    });
    await audit(tx, actor, 'REDEEM_POINTS', 'customer', customerId, { ...redemption });
  });
}

// ── Store credit ──────────────────────────────────────────────────────────────

export async function getStoreCreditHistory(
  customerId: number,
  paging: { page: number; pageSize: number },
): Promise<Paged<StoreCreditHistoryRecord>> {
  const result = await customers.storeCreditHistory(kysely, customerId, {
    limit: paging.pageSize,
    offset: (paging.page - 1) * paging.pageSize,
  });
  return paged(result, paging.page, paging.pageSize);
}

/** A back-office correction with a reason; customers spend store credit as a payment at checkout. */
export async function adjustStoreCredit(
  actor: Actor,
  customerId: number,
  adjustment: {
    amount: MoneyInput;
    direction: 'credit' | 'debit';
    reason: string;
    refType: string | null;
    refId: string | null;
  },
): Promise<void> {
  const amount = policy.checkAdjustmentAmount(adjustment.amount);

  await withTransaction({}, async (tx, client) => {
    const customer = await requireCustomer(tx, customerId);
    const balance = await customers.lockStoreCredit(tx, customerId);
    if (balance === undefined) throw new NotFoundError('Store credit account');
    if (adjustment.direction === 'debit') policy.checkEnoughStoreCredit(balance, amount);

    await customers.moveStoreCredit(tx, customerId, amount, {
      direction: adjustment.direction,
      refType: adjustment.refType,
      refId: adjustment.refId,
    });
    await audit(tx, actor, 'ADJUST_STORE_CREDIT', 'customer', customerId, {
      ...adjustment,
      amount: amount.toFixed(2),
    });
    if (adjustment.direction === 'credit') {
      await insertOutbox(client, 'customer.store_credit_added', {
        customerId,
        customerName: customer.fullName,
        amount: amount.toNumber(),
        branchId: customer.branchId ?? actor.branchId,
      });
    }
  });
}

// ── Customer groups ───────────────────────────────────────────────────────────

export function listCustomerGroups(): Promise<CustomerGroupRecord[]> {
  return customers.listGroups(kysely);
}

export async function createCustomerGroup(
  actor: Actor,
  dto: { name: string; description?: string | null; discountPct?: number },
): Promise<CustomerGroupRecord> {
  return withTransaction({}, async (tx) => {
    const group = await customers.insertGroup(tx, {
      name: dto.name,
      description: dto.description ?? null,
      discountPct: dto.discountPct ?? 0,
    });
    await audit(tx, actor, 'CREATE', 'customer_group', group.id, { name: dto.name });
    return group;
  });
}
