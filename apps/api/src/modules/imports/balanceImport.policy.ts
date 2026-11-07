import { CUSTOMER_BALANCE_IMPORT_COLUMNS, Money, SUPPLIER_BALANCE_IMPORT_COLUMNS } from '@bms/shared';
import { cellsOf, readAmount, readColumns, readCount } from './importFile.policy.js';

// The rules of the opening balance files (#246 part 3): pure, no database. A
// balance comes in once, before the shop's first sale; the same balance again
// is unchanged, another one is refused.

export type CustomerBalanceColumn = (typeof CUSTOMER_BALANCE_IMPORT_COLUMNS)[number];
export type SupplierBalanceColumn = (typeof SUPPLIER_BALANCE_IMPORT_COLUMNS)[number];

export interface CustomerBalanceRow {
  line: number;
  code: string | undefined;
  phone: string | undefined;
  email: string | undefined;
  /** Two decimals; undefined or zero: nothing owed. */
  owed: string | undefined;
  dueDate: string | undefined;
  storeCredit: string | undefined;
  points: number | undefined;
}

export interface SupplierBalanceRow {
  line: number;
  supplier: string;
  phone: string | undefined;
  email: string | undefined;
  owed: string;
}

export const SALES_STARTED = "Opening balances come in only before the shop's first sale: after it, correct a balance with its own tools (store credit adjustment, write-off, supplier credit note)";

export function readCustomerBalanceHeader(header: string[]) {
  const { index, errors } = readColumns(header, CUSTOMER_BALANCE_IMPORT_COLUMNS);
  if (index.Code === undefined && index.Phone === undefined && index.Email === undefined) errors.push('The file has no Code, Phone or Email column: start from the template');
  return { index, errors };
}

/** A calendar day written YYYY-MM-DD that exists. */
export function readDay(cell: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cell)) return null;
  const day = new Date(`${cell}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === cell ? cell : null;
}

export function readCustomerBalanceRow(
  cells: string[],
  index: Partial<Record<CustomerBalanceColumn, number>>,
  line: number,
  decimalComma: boolean,
): { row?: CustomerBalanceRow; messages: string[] } {
  const cell = cellsOf(cells, index);
  const value = (c: CustomerBalanceColumn) => cell(c) || undefined;
  const messages: string[] = [];
  if (!value('Code') && !value('Phone') && !value('Email')) messages.push('A balance needs the customer\'s Code, Phone or Email');
  const amount = (column: 'Amount Owed' | 'Store Credit'): string | undefined => {
    if (!value(column)) return undefined;
    const read = readAmount(cell(column), decimalComma, 2);
    if (read === null) messages.push(`${column} '${cell(column)}' is not an amount of 0 or more with at most two decimals`);
    return read ?? undefined;
  };
  const owed = amount('Amount Owed');
  const storeCredit = amount('Store Credit');
  let points: number | undefined;
  if (value('Loyalty Points')) {
    const read = readCount(cell('Loyalty Points'));
    if (read === null) messages.push(`Loyalty Points '${cell('Loyalty Points')}' is not a whole number of 0 or more`);
    else points = read;
  }
  let dueDate: string | undefined;
  if (value('Due Date')) {
    const read = readDay(cell('Due Date'));
    if (read === null) messages.push(`Due Date '${cell('Due Date')}' is not a date written YYYY-MM-DD`);
    else dueDate = read;
  } else if (owed && !Money.of(owed).isZero()) {
    messages.push('Due Date is empty: what a customer owes needs the day it is due');
  }
  if (messages.length > 0) return { messages };
  return { row: { line, code: value('Code'), phone: value('Phone'), email: value('Email'), owed, dueDate, storeCredit, points }, messages };
}

export function readSupplierBalanceHeader(header: string[]) {
  const { index, errors } = readColumns(header, SUPPLIER_BALANCE_IMPORT_COLUMNS);
  for (const column of ['Supplier', 'Amount Owed'] as const) {
    if (index[column] === undefined) errors.push(`The file has no ${column} column: start from the template`);
  }
  return { index, errors };
}

export function readSupplierBalanceRow(
  cells: string[],
  index: Partial<Record<SupplierBalanceColumn, number>>,
  line: number,
  decimalComma: boolean,
): { row?: SupplierBalanceRow; messages: string[] } {
  const cell = cellsOf(cells, index);
  const messages: string[] = [];
  if (!cell('Supplier')) messages.push('Supplier is empty');
  else if (cell('Supplier').length > 200) messages.push('Supplier is longer than 200 characters');
  const owed = readAmount(cell('Amount Owed'), decimalComma, 2);
  if (owed === null || Money.of(owed).isZero()) messages.push(`Amount Owed '${cell('Amount Owed')}' is not an amount more than 0 with at most two decimals`);
  if (messages.length > 0) return { messages };
  return { row: { line, supplier: cell('Supplier'), phone: cell('Phone') || undefined, email: cell('Email') || undefined, owed: owed! }, messages };
}

/**
 * Whether a balance in the file is new, the one already brought in, or a
 * different one (refused). `given` undefined or zero: the row brings none.
 */
export function balanceDecision(given: string | number | undefined, existing: string | number | undefined): 'none' | 'new' | 'same' | 'different' {
  const none = (v: string | number | undefined) => v === undefined || Money.of(v).isZero();
  if (none(given)) return 'none';
  if (existing === undefined) return 'new';
  return Money.of(given!).equals(existing) ? 'same' : 'different';
}
