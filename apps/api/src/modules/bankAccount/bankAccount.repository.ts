import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import type {
  BankAccountRecord,
  BankEntryRecord,
  BankMovement,
  Direction,
  NewStatementLine,
  StatementLineRecord,
} from './bankAccount.types.js';

// Bank accounts, the system's bank movements (bank_reconciliation) and the
// bank's statement lines (#21). Accounts are branch-owned: lists take the
// branch, and single accounts are checked against the route's branch by the
// service.

type Page = { limit: number; offset: number };

function selectAccounts(q: Queryable) {
  return q
    .selectFrom('bank_accounts as a')
    .select([
      'a.id',
      'a.branch_id',
      'a.account_name',
      'a.bank_name',
      'a.account_number',
      'a.iban',
      'a.currency',
      'a.is_active',
      'a.created_at',
      sql<boolean>`EXISTS (SELECT 1 FROM bank_reconciliation e WHERE e.bank_account_id = a.id)`.as('has_movements'),
    ]);
}

function toAccount(r: Awaited<ReturnType<ReturnType<typeof selectAccounts>['executeTakeFirstOrThrow']>>): BankAccountRecord {
  return {
    id: r.id,
    branchId: r.branch_id,
    accountName: r.account_name,
    bankName: r.bank_name,
    accountNumber: r.account_number,
    iban: r.iban,
    currency: r.currency,
    isActive: r.is_active,
    createdAt: r.created_at,
    hasMovements: r.has_movements,
  };
}

export async function listAccounts(
  q: Queryable,
  filter: { branchId: number; isActive?: boolean },
  page: Page,
): Promise<{ items: BankAccountRecord[]; total: number }> {
  let query = selectAccounts(q).where('a.branch_id', '=', filter.branchId);
  if (filter.isActive !== undefined) query = query.where('a.is_active', '=', filter.isActive);
  const [rows, count] = await Promise.all([
    query.orderBy('a.account_name').orderBy('a.id').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toAccount), total: Number(count.count) };
}

export async function findAccount(q: Queryable, id: number, opts: { forUpdate?: boolean } = {}): Promise<BankAccountRecord | undefined> {
  let query = selectAccounts(q).where('a.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('a');
  const row = await query.executeTakeFirst();
  return row && toAccount(row);
}

export async function insertAccount(
  q: Queryable,
  a: { branchId: number; accountName: string; bankName: string; accountNumber: string; accountNumberHash: string; iban: string | null; currency: string },
): Promise<number> {
  const row = await q
    .insertInto('bank_accounts')
    .values({
      branch_id: a.branchId,
      account_name: a.accountName,
      bank_name: a.bankName,
      account_number: a.accountNumber,
      account_number_hash: a.accountNumberHash,
      iban: a.iban,
      currency: a.currency,
      is_active: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function updateAccount(
  q: Queryable,
  id: number,
  set: Partial<{ accountName: string; bankName: string; accountNumber: string; accountNumberHash: string; iban: string | null; currency: string }>,
): Promise<void> {
  const values = {
    ...(set.accountName !== undefined && { account_name: set.accountName }),
    ...(set.bankName !== undefined && { bank_name: set.bankName }),
    ...(set.accountNumber !== undefined && { account_number: set.accountNumber }),
    ...(set.accountNumberHash !== undefined && { account_number_hash: set.accountNumberHash }),
    ...(set.iban !== undefined && { iban: set.iban }),
    ...(set.currency !== undefined && { currency: set.currency }),
  };
  if (Object.keys(values).length === 0) return;
  await q.updateTable('bank_accounts').set(values).where('id', '=', id).execute();
}

export async function setActive(q: Queryable, id: number, isActive: boolean): Promise<void> {
  await q.updateTable('bank_accounts').set({ is_active: isActive }).where('id', '=', id).execute();
}

// ── Movements (bank_reconciliation) ───────────────────────────────────────────

function selectEntries(q: Queryable) {
  return q
    .selectFrom('bank_reconciliation as e')
    .select([
      'e.id',
      'e.bank_account_id',
      'e.source_type',
      'e.source_id',
      'e.amount',
      'e.direction',
      'e.status',
      'e.notes',
      'e.created_at',
      sql<string>`TO_CHAR(e.created_at, 'YYYY-MM-DD')`.as('made_on'),
    ]);
}

function toEntry(r: Awaited<ReturnType<ReturnType<typeof selectEntries>['executeTakeFirstOrThrow']>>): BankEntryRecord {
  return {
    id: String(r.id),
    bankAccountId: r.bank_account_id,
    sourceType: r.source_type,
    sourceId: r.source_id,
    amount: Money.of(r.amount),
    direction: r.direction as Direction,
    status: r.status as BankEntryRecord['status'],
    notes: r.notes,
    createdAt: r.created_at,
    madeOn: r.made_on,
  };
}

export async function listEntries(
  q: Queryable,
  filter: { bankAccountId: number; status?: 'uncleared' | 'cleared' },
  page: Page,
): Promise<{ items: BankEntryRecord[]; total: number }> {
  let query = selectEntries(q).where('e.bank_account_id', '=', filter.bankAccountId);
  if (filter.status) query = query.where('e.status', '=', filter.status);
  const [rows, count] = await Promise.all([
    query.orderBy('e.created_at', 'desc').orderBy('e.id', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toEntry), total: Number(count.count) };
}

export async function findEntry(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<BankEntryRecord | undefined> {
  let query = selectEntries(q).where('e.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('e');
  const row = await query.executeTakeFirst();
  return row && toEntry(row);
}

export async function findEntryBySource(q: Queryable, sourceType: string, sourceId: string): Promise<BankEntryRecord | undefined> {
  const row = await selectEntries(q).where('e.source_type', '=', sourceType).where('e.source_id', '=', sourceId).forUpdate('e').executeTakeFirst();
  return row && toEntry(row);
}

/** The open movements of an account that a statement dated `date` could stand for, locked. */
export async function openEntriesNear(q: Queryable, bankAccountId: number, date: string, days: number): Promise<BankEntryRecord[]> {
  const rows = await selectEntries(q)
    .where('e.bank_account_id', '=', bankAccountId)
    .where('e.status', '=', 'uncleared')
    .where(sql<boolean>`e.created_at::date BETWEEN ${date}::date - ${days}::int AND ${date}::date + ${days}::int`)
    .orderBy('e.id')
    .forUpdate('e')
    .execute();
  return rows.map(toEntry);
}

export async function insertEntry(q: Queryable, m: BankMovement): Promise<void> {
  await q
    .insertInto('bank_reconciliation')
    .values({
      bank_account_id: m.bankAccountId,
      amount: m.amount.toFixed(2),
      direction: m.direction,
      status: 'uncleared',
      source_type: m.sourceType,
      source_id: m.sourceId,
      notes: m.notes,
    })
    .execute();
}

export async function deleteEntry(q: Queryable, id: string): Promise<void> {
  await q.deleteFrom('bank_reconciliation').where('id', '=', id).where('status', '=', 'uncleared').execute();
}

export async function setEntryStatus(q: Queryable, id: string, status: 'uncleared' | 'cleared'): Promise<void> {
  await q.updateTable('bank_reconciliation').set({ status }).where('id', '=', id).execute();
}

/** Whether the account is active and belongs to the branch: the one a payment there may use. */
export async function usableAccount(q: Queryable, id: number, branchId: number): Promise<boolean> {
  const row = await q
    .selectFrom('bank_accounts')
    .select('id')
    .where('id', '=', id)
    .where('branch_id', '=', branchId)
    .where('is_active', '=', true)
    .executeTakeFirst();
  return row !== undefined;
}

// ── Statement lines ───────────────────────────────────────────────────────────

function selectLines(q: Queryable) {
  return q
    .selectFrom('bank_statement_lines as l')
    .select([
      'l.id',
      'l.bank_account_id',
      sql<string>`TO_CHAR(l.statement_date, 'YYYY-MM-DD')`.as('statement_date'),
      'l.amount',
      'l.direction',
      'l.reference',
      'l.description',
      'l.entry_id',
      'l.matched_at',
      'l.imported_at',
    ]);
}

function toLine(r: Awaited<ReturnType<ReturnType<typeof selectLines>['executeTakeFirstOrThrow']>>): StatementLineRecord {
  return {
    id: String(r.id),
    bankAccountId: r.bank_account_id,
    statementDate: r.statement_date,
    amount: Money.of(r.amount),
    direction: r.direction as Direction,
    reference: r.reference,
    description: r.description,
    entryId: r.entry_id === null ? null : String(r.entry_id),
    matchedAt: r.matched_at,
    importedAt: r.imported_at,
  };
}

export async function listLines(
  q: Queryable,
  filter: { bankAccountId: number; matched?: boolean },
  page: Page,
): Promise<{ items: StatementLineRecord[]; total: number }> {
  let query = selectLines(q).where('l.bank_account_id', '=', filter.bankAccountId);
  if (filter.matched !== undefined) query = query.where('l.entry_id', filter.matched ? 'is not' : 'is', null);
  const [rows, count] = await Promise.all([
    query.orderBy('l.statement_date', 'desc').orderBy('l.id', 'desc').limit(page.limit).offset(page.offset).execute(),
    query.clearSelect().select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toLine), total: Number(count.count) };
}

export async function findLine(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<StatementLineRecord | undefined> {
  let query = selectLines(q).where('l.id', '=', id);
  if (opts.forUpdate) query = query.forUpdate('l');
  const row = await query.executeTakeFirst();
  return row && toLine(row);
}

/** Inserts the line; undefined when a line with its reference was imported before. */
export async function insertLine(q: Queryable, bankAccountId: number, l: NewStatementLine, by: number): Promise<string | undefined> {
  const row = await q
    .insertInto('bank_statement_lines')
    .values({
      bank_account_id: bankAccountId,
      statement_date: l.statementDate,
      amount: l.amount.toFixed(2),
      direction: l.direction,
      reference: l.reference,
      description: l.description,
      imported_by: by,
    })
    .onConflict((oc) => oc.columns(['bank_account_id', 'reference']).where('reference', 'is not', null).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row && String(row.id);
}

export async function setLineMatch(q: Queryable, lineId: string, entryId: string | null, by: number | null): Promise<void> {
  await q
    .updateTable('bank_statement_lines')
    .set({ entry_id: entryId, matched_by: by, matched_at: entryId === null ? null : sql<Date>`now()` })
    .where('id', '=', lineId)
    .execute();
}
