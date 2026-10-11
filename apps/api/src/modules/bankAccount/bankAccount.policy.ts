import { BusinessError, ConflictError, ValidationError } from '../../lib/errors.js';
import type { BankEntryRecord, NewStatementLine, StatementLineRecord } from './bankAccount.types.js';

/** Bank account and reconciliation rules (#21). Pure functions; the service applies them. */

/** A statement line and a movement may be matched automatically up to this many days apart. */
export const MATCH_WINDOW_DAYS = 3;

/** The form an account number is compared in: no spaces or dashes, upper case. */
export function normalizeAccountNumber(n: string): string {
  return n.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Once money has moved through an account, its number, IBAN and currency
 * stay as they are (owner decision 3a): a different account is a new account.
 */
export function checkEditable(hasMovements: boolean, changes: { accountNumber?: unknown; iban?: unknown; currency?: unknown }): void {
  if (!hasMovements) return;
  if (changes.accountNumber !== undefined || changes.iban !== undefined || changes.currency !== undefined) {
    throw new BusinessError(
      'BANK_ACCOUNT_IN_USE',
      'Money has moved through this account, so its number, IBAN and currency stay as they are. Open a new account instead.',
    );
  }
}

/**
 * The account a bank payment goes to. With the module on, every bank
 * payment names one (owner decision 2a); with it off, none is needed.
 */
export function requireAccount(bankAccountId: number | null, moduleOn: boolean): number | null {
  if (bankAccountId === null && moduleOn) throw new ValidationError('bankAccountId is required for bank payments');
  return bankAccountId;
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * The movement a new statement line is matched to on import: the only one
 * left open with the same amount and direction within MATCH_WINDOW_DAYS.
 * None, or more than one, and the line waits to be matched by hand.
 */
export function autoMatch(line: NewStatementLine, open: BankEntryRecord[]): BankEntryRecord | undefined {
  const candidates = open.filter(
    (e) =>
      e.status === 'uncleared' &&
      e.direction === line.direction &&
      e.amount.minus(line.amount).isZero() &&
      daysApart(e.madeOn, line.statementDate) <= MATCH_WINDOW_DAYS,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** A line is matched by hand to one open movement of the same account, amount and direction. */
export function checkMatch(line: StatementLineRecord, entry: BankEntryRecord): void {
  if (line.entryId !== null) throw new ConflictError('ALREADY_CLEARED', 'This statement line is already matched');
  if (entry.status === 'cleared') throw new ConflictError('ALREADY_CLEARED', 'This movement is already matched to a statement line');
  if (entry.bankAccountId !== line.bankAccountId || entry.direction !== line.direction || !entry.amount.minus(line.amount).isZero()) {
    throw new BusinessError('MATCH_MISMATCH', 'A statement line matches a movement of the same account, amount and direction', {
      line: { amount: line.amount.toNumber(), direction: line.direction },
      entry: { amount: entry.amount.toNumber(), direction: entry.direction },
    });
  }
}

export function checkUnmatch(line: StatementLineRecord): string {
  if (line.entryId === null) throw new ConflictError('NOT_MATCHED', 'This statement line is not matched');
  return line.entryId;
}

/** A movement already matched to the statement stays; the payment it records can no longer be undone. */
export function checkCancellable(entry: BankEntryRecord | undefined): void {
  if (entry?.status === 'cleared') {
    throw new BusinessError('BANK_ENTRY_CLEARED', 'This payment is already matched to the bank statement; unmatch it first');
  }
}
