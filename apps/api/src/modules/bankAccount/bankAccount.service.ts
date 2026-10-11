import { createHash } from 'node:crypto';
import type { CreateBankAccountRequest, UpdateBankAccountRequest } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { isUniqueViolation } from '../../db/errors.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { encrypt } from '../../lib/encryption.js';
import { BusinessError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as policy from './bankAccount.policy.js';
import * as repo from './bankAccount.repository.js';
import type { Actor, BankAccountRecord, BankMovement, BankSourceType, NewStatementLine } from './bankAccount.types.js';

// Bank accounts and their reconciliation (#21). Owner decisions: two-sided
// reconciliation, statement lines matched to the system's movements (1a);
// with the module on, every bank payment names an account and lands here (2a);
// ETB accounts, each number registered once, fixed once money has moved (3a).

type Page = { limit: number; offset: number };

/** The module is on only with FEATURE_BANK_ACCOUNTS=true until feature flags (#27). */
export function bankAccountsEnabled(): boolean {
  return process.env.FEATURE_BANK_ACCOUNTS === 'true';
}

function numberHash(accountNumber: string): string {
  return createHash('sha256').update(policy.normalizeAccountNumber(accountNumber)).digest('hex');
}

/** The account, if it belongs to the branch in the URL; otherwise 404, as if it did not exist. */
async function accountIn(q: Queryable, branchId: number, id: number, opts: { forUpdate?: boolean } = {}): Promise<BankAccountRecord> {
  const account = await repo.findAccount(q, id, opts);
  if (!account || account.branchId !== branchId) throw new NotFoundError('Bank account');
  return account;
}

function audit(tx: Queryable, actor: Actor, action: string, entityType: string, entityId: string | number, branchId: number, meta: Record<string, unknown>) {
  return insertAuditEntry(tx, { staffId: actor.staffId, staffRole: actor.role, branchId, action, entityType, entityId, meta });
}

function duplicateNumber(err: unknown): never {
  if (isUniqueViolation(err)) {
    throw new ConflictError('DUPLICATE_ACCOUNT_NUMBER', 'A bank account with this number is already registered');
  }
  throw err;
}

// ── Accounts ──────────────────────────────────────────────────────────────────

export function listAccounts(branchId: number, isActive: boolean | undefined, page: Page) {
  return repo.listAccounts(kysely, { branchId, isActive }, page);
}

export function getAccount(branchId: number, id: number): Promise<BankAccountRecord> {
  return accountIn(kysely, branchId, id);
}

export async function createAccount(actor: Actor, branchId: number, input: CreateBankAccountRequest): Promise<BankAccountRecord> {
  try {
    const id = await withTransaction({}, async (tx) => {
      const branch = await tx.selectFrom('branches').select('id').where('id', '=', branchId).executeTakeFirst();
      if (!branch) throw new NotFoundError('Branch');
      const id = await repo.insertAccount(tx, {
        branchId,
        accountName: input.accountName,
        bankName: input.bankName,
        accountNumber: encrypt(input.accountNumber),
        accountNumberHash: numberHash(input.accountNumber),
        iban: input.iban ? encrypt(input.iban) : null,
        currency: input.currency,
      });
      await audit(tx, actor, 'CREATE', 'bank_account', id, branchId, { accountName: input.accountName, bankName: input.bankName, currency: input.currency });
      return id;
    });
    return getAccount(branchId, id);
  } catch (err) {
    return duplicateNumber(err);
  }
}

export async function updateAccount(actor: Actor, branchId: number, id: number, input: UpdateBankAccountRequest): Promise<BankAccountRecord> {
  try {
    await withTransaction({}, async (tx) => {
      const account = await accountIn(tx, branchId, id, { forUpdate: true });
      policy.checkEditable(account.hasMovements, input);
      await repo.updateAccount(tx, id, {
        accountName: input.accountName,
        bankName: input.bankName,
        ...(input.accountNumber !== undefined && { accountNumber: encrypt(input.accountNumber), accountNumberHash: numberHash(input.accountNumber) }),
        ...(input.iban !== undefined && { iban: input.iban ? encrypt(input.iban) : null }),
        currency: input.currency,
      });
      await audit(tx, actor, 'UPDATE', 'bank_account', id, branchId, { updatedFields: Object.keys(input) });
    });
  } catch (err) {
    duplicateNumber(err);
  }
  return getAccount(branchId, id);
}

/** Deactivated accounts take no new payments but keep their movements and reconciliation; a repeat changes nothing. */
export async function setActive(actor: Actor, branchId: number, id: number, isActive: boolean): Promise<BankAccountRecord> {
  await withTransaction({}, async (tx) => {
    const account = await accountIn(tx, branchId, id, { forUpdate: true });
    if (account.isActive === isActive) return;
    await repo.setActive(tx, id, isActive);
    await audit(tx, actor, isActive ? 'ACTIVATE' : 'INACTIVATE', 'bank_account', id, branchId, {});
  });
  return getAccount(branchId, id);
}

// ── Reconciliation ────────────────────────────────────────────────────────────

export async function listEntries(branchId: number, id: number, status: 'uncleared' | 'cleared' | undefined, page: Page) {
  await accountIn(kysely, branchId, id);
  return repo.listEntries(kysely, { bankAccountId: id, status }, page);
}

export async function listLines(branchId: number, id: number, matched: boolean | undefined, page: Page) {
  await accountIn(kysely, branchId, id);
  return repo.listLines(kysely, { bankAccountId: id, matched }, page);
}

/**
 * Imports statement lines, skipping those whose reference was imported
 * before, and matches each to the only open movement of the same amount and
 * direction within 3 days, if there is exactly one.
 */
export async function importStatement(
  actor: Actor,
  branchId: number,
  id: number,
  lines: NewStatementLine[],
): Promise<{ imported: number; matched: number; duplicates: number }> {
  return withTransaction({}, async (tx) => {
    await accountIn(tx, branchId, id, { forUpdate: true });
    let imported = 0;
    let matched = 0;
    for (const line of lines) {
      const lineId = await repo.insertLine(tx, id, line, actor.staffId);
      if (lineId === undefined) continue;
      imported++;
      const entry = policy.autoMatch(line, await repo.openEntriesNear(tx, id, line.statementDate, policy.MATCH_WINDOW_DAYS));
      if (entry) {
        await repo.setLineMatch(tx, lineId, entry.id, actor.staffId);
        await repo.setEntryStatus(tx, entry.id, 'cleared');
        matched++;
      }
    }
    const duplicates = lines.length - imported;
    await audit(tx, actor, 'CREATE', 'bank_statement', id, branchId, { lines: lines.length, imported, matched, duplicates });
    return { imported, matched, duplicates };
  });
}

async function lineIn(tx: Queryable, branchId: number, id: number, lineId: string) {
  await accountIn(tx, branchId, id);
  const line = await repo.findLine(tx, lineId, { forUpdate: true });
  if (!line || line.bankAccountId !== id) throw new NotFoundError('Statement line');
  return line;
}

/** Matches a line by hand to an open movement of the same account, amount and direction; both are cleared. */
export async function matchLine(actor: Actor, branchId: number, id: number, lineId: string, entryId: string): Promise<void> {
  await withTransaction({}, async (tx) => {
    const line = await lineIn(tx, branchId, id, lineId);
    const entry = await repo.findEntry(tx, entryId, { forUpdate: true });
    if (!entry || entry.bankAccountId !== id) throw new NotFoundError('Bank movement');
    policy.checkMatch(line, entry);
    await repo.setLineMatch(tx, lineId, entryId, actor.staffId);
    await repo.setEntryStatus(tx, entryId, 'cleared');
    await audit(tx, actor, 'UPDATE', 'bank_statement_line', lineId, branchId, { action: 'match', entryId });
  });
}

/** Undoes a match made by mistake: the line and the movement are open again. */
export async function unmatchLine(actor: Actor, branchId: number, id: number, lineId: string): Promise<void> {
  await withTransaction({}, async (tx) => {
    const line = await lineIn(tx, branchId, id, lineId);
    const entryId = policy.checkUnmatch(line);
    await repo.setLineMatch(tx, lineId, null, null);
    await repo.setEntryStatus(tx, entryId, 'uncleared');
    await audit(tx, actor, 'UPDATE', 'bank_statement_line', lineId, branchId, { action: 'unmatch', entryId });
  });
}

// ── Bank payments elsewhere (owner decision 2a) ───────────────────────────────

/**
 * The account a bank payment in the branch goes to: required with the module
 * on, and then active and of that branch. With the module off none is needed.
 */
export async function accountForPayment(q: Queryable, bankAccountId: number | null, branchId: number): Promise<number | null> {
  const id = policy.requireAccount(bankAccountId, bankAccountsEnabled());
  if (id !== null && !(await repo.usableAccount(q, id, branchId))) {
    throw new BusinessError('INVALID_BANK_ACCOUNT', 'Bank account is inactive or does not belong to this branch');
  }
  return id;
}

/** Records a bank movement for reconciliation, in the caller's transaction. */
export function recordMovement(q: Queryable, m: BankMovement): Promise<void> {
  return repo.insertEntry(q, m);
}

/**
 * Takes back the movement a payment recorded, when the payment itself is
 * undone as a mistake. Refused once it is matched to the statement.
 */
export async function cancelMovement(q: Queryable, sourceType: BankSourceType, sourceId: string): Promise<void> {
  const entry = await repo.findEntryBySource(q, sourceType, sourceId);
  policy.checkCancellable(entry);
  if (entry) await repo.deleteEntry(q, entry.id);
}
