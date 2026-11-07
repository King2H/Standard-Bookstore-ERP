import { CUSTOMER_IMPORT_COLUMNS } from '@bms/shared';
import { cellsOf, readColumns } from './importFile.policy.js';

// The rules of a customer file (#246): pure, no database. A customer is found
// again by code, else phone, else email; an empty cell leaves a value as it is.

export type CustomerColumn = (typeof CUSTOMER_IMPORT_COLUMNS)[number];

export interface CustomerRow {
  line: number;
  code: string | undefined;
  name: string | undefined;
  phone: string | undefined;
  email: string | undefined;
  address: string | undefined;
  city: string | undefined;
}

export function readCustomerHeader(header: string[]) {
  const { index, errors } = readColumns(header, CUSTOMER_IMPORT_COLUMNS);
  if (index.Name === undefined) errors.push('The file has no Name column: start from the template');
  return { index, errors };
}

export function readCustomerRow(cells: string[], index: Partial<Record<CustomerColumn, number>>, line: number): { row?: CustomerRow; messages: string[] } {
  const cell = cellsOf(cells, index);
  const value = (c: CustomerColumn) => cell(c) || undefined;
  const messages: string[] = [];
  if (!value('Code') && !value('Phone') && !value('Email')) {
    messages.push('A customer needs a Code, a Phone or an Email, so that importing the file again finds them');
  }
  if ((value('Name') ?? '').length > 200) messages.push('Name is longer than 200 characters');
  if (messages.length > 0) return { messages };
  return {
    row: { line, code: value('Code'), name: value('Name'), phone: value('Phone'), email: value('Email'), address: value('Address'), city: value('City') },
    messages,
  };
}
