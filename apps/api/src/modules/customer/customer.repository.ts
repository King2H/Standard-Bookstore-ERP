import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import { toCustomerRecord, type CustomerRow } from './customer.mapper.js';
import type {
  CustomerChanges,
  CustomerFilter,
  CustomerGroupRecord,
  CustomerGroupRef,
  CustomerRecord,
  LoyaltyHistoryRecord,
  NewCustomer,
  StoreCreditHistoryRecord,
} from './customer.types.js';

// Customers are shared by every branch, so these queries take no branch
// scope; branch_id is the customer's home branch, a filter only.
// Tenant scope arrives with tenancy (#13).

function selectCustomers(q: Queryable) {
  return q
    .selectFrom('customers as c')
    .leftJoin('loyalty_accounts as la', 'la.customer_id', 'c.id')
    .leftJoin('store_credit_accounts as sca', 'sca.customer_id', 'c.id')
    .select([
      'c.id',
      'c.branch_id',
      'c.customer_code',
      'c.full_name',
      'c.phone_encrypted',
      'c.email_encrypted',
      'c.gender',
      'c.date_of_birth',
      'c.address',
      'c.city',
      'c.is_active',
      'c.status',
      'c.archived_at',
      'c.created_at',
      sql<string>`COALESCE(la.points_balance, 0)`.as('points_balance'),
      sql<string>`COALESCE(la.lifetime_points, 0)`.as('lifetime_points'),
      sql<string>`COALESCE(sca.balance, 0)`.as('store_credit_balance'),
      sql<string>`COALESCE((
        SELECT SUM(r.outstanding_amount) FROM receivables r
        WHERE r.customer_id = c.id AND r.status IN ('Pending', 'PartiallyPaid', 'Overdue')
      ), 0)`.as('outstanding_receivables'),
    ]);
}

async function groupsOf(q: Queryable, customerIds: number[]): Promise<Map<number, CustomerGroupRef[]>> {
  const groups = new Map<number, CustomerGroupRef[]>();
  if (customerIds.length === 0) return groups;
  const rows = await q
    .selectFrom('customer_group_membership as cgm')
    .innerJoin('customer_groups as cg', 'cg.id', 'cgm.group_id')
    .select(['cgm.customer_id', 'cg.id', 'cg.name', 'cg.discount_pct'])
    .where('cgm.customer_id', 'in', customerIds)
    .orderBy('cg.name')
    .execute();
  for (const r of rows) {
    const list = groups.get(r.customer_id) ?? [];
    list.push({ id: r.id, name: r.name, discountPct: Number(r.discount_pct) });
    groups.set(r.customer_id, list);
  }
  return groups;
}

async function withGroups(q: Queryable, rows: CustomerRow[]): Promise<CustomerRecord[]> {
  const groups = await groupsOf(q, rows.map((r) => r.id));
  return rows.map((r) => toCustomerRecord(r, groups.get(r.id) ?? []));
}

export async function findById(q: Queryable, id: number): Promise<CustomerRecord | undefined> {
  const row = await selectCustomers(q).where('c.id', '=', id).executeTakeFirst();
  return row && (await withGroups(q, [row as CustomerRow]))[0];
}

export async function exists(q: Queryable, id: number): Promise<{ fullName: string; customerCode: string; branchId: number | null } | undefined> {
  const row = await q
    .selectFrom('customers')
    .select(['full_name', 'customer_code', 'branch_id'])
    .where('id', '=', id)
    .executeTakeFirst();
  return row && { fullName: row.full_name, customerCode: row.customer_code, branchId: row.branch_id };
}

export async function list(
  q: Queryable,
  filter: CustomerFilter & { qLookup?: string | null },
  page: { limit: number; offset: number },
): Promise<{ items: CustomerRecord[]; total: number }> {
  let query = selectCustomers(q);
  if (filter.q) {
    // Name and code match in part; phone and email are encrypted, so they
    // match only exactly, through their lookup hash (#90).
    const like = `%${filter.q}%`;
    query = query.where((eb) =>
      eb.or([
        eb('c.full_name', 'ilike', like),
        eb('c.customer_code', 'ilike', like),
        ...(filter.qLookup ? [eb('c.phone_lookup', '=', filter.qLookup), eb('c.email_lookup', '=', filter.qLookup)] : []),
      ]),
    );
  }
  if (filter.branchId !== undefined) query = query.where('c.branch_id', '=', filter.branchId);
  if (filter.statuses) query = query.where('c.status', 'in', filter.statuses);
  else if (filter.isActive !== undefined) query = query.where('c.is_active', '=', filter.isActive);
  if (filter.groupId !== undefined) {
    const groupId = filter.groupId;
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('customer_group_membership as cgm')
          .select('cgm.customer_id')
          .whereRef('cgm.customer_id', '=', 'c.id')
          .where('cgm.group_id', '=', groupId),
      ),
    );
  }

  const [rows, count] = await Promise.all([
    query.orderBy('c.full_name').orderBy('c.id').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: await withGroups(q, rows as CustomerRow[]), total: Number(count.count) };
}

/** Another customer already using this phone or email, found by its lookup hash. */
export async function findContactOwner(
  q: Queryable,
  field: 'phone' | 'email',
  lookup: string,
  exceptId?: number,
): Promise<number | undefined> {
  let query = q
    .selectFrom('customers')
    .select('id')
    .where(field === 'phone' ? 'phone_lookup' : 'email_lookup', '=', lookup);
  if (exceptId !== undefined) query = query.where('id', '!=', exceptId);
  return (await query.executeTakeFirst())?.id;
}

/** The highest number used in a CUS-nnnn code so far (0 when none). */
export async function highestCustomerNumber(q: Queryable): Promise<number> {
  const row = await q
    .selectFrom('customers')
    .select(sql<number>`COALESCE(MAX(CAST(SUBSTRING(customer_code FROM 5) AS INTEGER)), 0)`.as('n'))
    .where(sql<boolean>`customer_code ~ '^CUS-[0-9]+$'`)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Inserts the customer with empty loyalty and store-credit accounts. */
export async function insert(q: Queryable, c: NewCustomer): Promise<number> {
  const { id } = await q
    .insertInto('customers')
    .values({
      branch_id: c.branchId,
      customer_code: c.customerCode,
      full_name: c.fullName,
      phone_encrypted: c.phone.encrypted,
      phone_lookup: c.phone.lookup,
      email_encrypted: c.email.encrypted,
      email_lookup: c.email.lookup,
      gender: c.gender,
      date_of_birth: c.dateOfBirth,
      address: c.address,
      city: c.city,
      created_by: c.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await q.insertInto('loyalty_accounts').values({ customer_id: id, points_balance: '0', lifetime_points: '0' }).execute();
  await q.insertInto('store_credit_accounts').values({ customer_id: id, balance: '0' }).execute();
  return id;
}

/** Changes only the fields given; phone and email change with their encrypted copy and lookup hash. */
export async function update(q: Queryable, id: number, ch: CustomerChanges): Promise<void> {
  await q
    .updateTable('customers')
    .set({
      ...(ch.fullName !== undefined && { full_name: ch.fullName }),
      ...(ch.phone !== undefined && {
        phone_encrypted: ch.phone.encrypted,
        phone_lookup: ch.phone.lookup,
      }),
      ...(ch.email !== undefined && {
        email_encrypted: ch.email.encrypted,
        email_lookup: ch.email.lookup,
      }),
      ...(ch.gender !== undefined && { gender: ch.gender }),
      ...(ch.dateOfBirth !== undefined && { date_of_birth: ch.dateOfBirth }),
      ...(ch.address !== undefined && { address: ch.address }),
      ...(ch.city !== undefined && { city: ch.city }),
      ...(ch.branchId !== undefined && { branch_id: ch.branchId }),
      updated_by: ch.updatedBy,
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .execute();
}

// ── Loyalty ───────────────────────────────────────────────────────────────────

/** The points balance, locked until the transaction ends; undefined without an account. */
export async function lockPoints(q: Queryable, customerId: number): Promise<number | undefined> {
  const row = await q
    .selectFrom('loyalty_accounts')
    .select('points_balance')
    .where('customer_id', '=', customerId)
    .forUpdate()
    .executeTakeFirst();
  return row && Number(row.points_balance);
}

/** Adds (or with a negative delta removes) points; earned points also count towards the lifetime total. */
export async function addPoints(
  q: Queryable,
  customerId: number,
  delta: number,
  entry: { reason: 'ACCRUAL' | 'REDEMPTION' | 'REFUND' | 'VOID_REVERSAL'; transactionRef: string | null },
): Promise<void> {
  await q
    .updateTable('loyalty_accounts')
    .set((eb) => ({
      points_balance: eb('points_balance', '+', String(delta)),
      // Only earned points count towards the lifetime total; points given
      // back on a refund or a void were earned once already.
      ...(delta > 0 && entry.reason === 'ACCRUAL' && { lifetime_points: eb('lifetime_points', '+', String(delta)) }),
      updated_at: sql`now()`,
    }))
    .where('customer_id', '=', customerId)
    .execute();
  await q
    .insertInto('loyalty_history')
    .values({ customer_id: customerId, transaction_ref: entry.transactionRef, points_delta: String(delta), reason: entry.reason })
    .execute();
}

export async function loyaltyHistory(
  q: Queryable,
  customerId: number,
  page: { limit: number; offset: number },
): Promise<{ items: LoyaltyHistoryRecord[]; total: number }> {
  const query = q.selectFrom('loyalty_history').where('customer_id', '=', customerId);
  const [rows, count] = await Promise.all([
    query
      .select(['id', 'customer_id', 'transaction_ref', 'points_delta', 'reason', 'created_at'])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      customerId: r.customer_id,
      transactionRef: r.transaction_ref,
      pointsDelta: Number(r.points_delta),
      reason: r.reason,
      createdAt: r.created_at,
    })),
    total: Number(count.count),
  };
}

// ── Store credit ──────────────────────────────────────────────────────────────

/** The store-credit balance, locked until the transaction ends; undefined without an account. */
export async function lockStoreCredit(q: Queryable, customerId: number): Promise<Money | undefined> {
  const row = await q
    .selectFrom('store_credit_accounts')
    .select('balance')
    .where('customer_id', '=', customerId)
    .forUpdate()
    .executeTakeFirst();
  return row && Money.of(row.balance);
}

export async function moveStoreCredit(
  q: Queryable,
  customerId: number,
  amount: Money,
  entry: { direction: 'credit' | 'debit'; refType: string | null; refId: string | null },
): Promise<void> {
  const value = amount.toFixed(2);
  await q
    .updateTable('store_credit_accounts')
    .set((eb) => ({ balance: eb('balance', entry.direction === 'credit' ? '+' : '-', value) }))
    .where('customer_id', '=', customerId)
    .execute();
  await q
    .insertInto('store_credit_history')
    .values({ customer_id: customerId, ref_type: entry.refType, ref_id: entry.refId, amount: value, direction: entry.direction })
    .execute();
}

export async function storeCreditHistory(
  q: Queryable,
  customerId: number,
  page: { limit: number; offset: number },
): Promise<{ items: StoreCreditHistoryRecord[]; total: number }> {
  const query = q.selectFrom('store_credit_history').where('customer_id', '=', customerId);
  const [rows, count] = await Promise.all([
    query
      .select(['id', 'customer_id', 'ref_type', 'ref_id', 'amount', 'direction', 'created_at'])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      customerId: r.customer_id,
      refType: r.ref_type,
      refId: r.ref_id,
      amount: Money.of(r.amount),
      direction: r.direction as 'credit' | 'debit',
      createdAt: r.created_at,
    })),
    total: Number(count.count),
  };
}

// ── Customer groups ───────────────────────────────────────────────────────────

export async function listGroups(q: Queryable): Promise<CustomerGroupRecord[]> {
  const rows = await q.selectFrom('customer_groups').select(['id', 'name', 'description', 'discount_pct']).orderBy('name').execute();
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, discountPct: Number(r.discount_pct) }));
}

export async function insertGroup(
  q: Queryable,
  g: { name: string; description: string | null; discountPct: number },
): Promise<CustomerGroupRecord> {
  const r = await q
    .insertInto('customer_groups')
    .values({ name: g.name, description: g.description, discount_pct: String(g.discountPct) })
    .returning(['id', 'name', 'description', 'discount_pct'])
    .executeTakeFirstOrThrow();
  return { id: r.id, name: r.name, description: r.description, discountPct: Number(r.discount_pct) };
}
