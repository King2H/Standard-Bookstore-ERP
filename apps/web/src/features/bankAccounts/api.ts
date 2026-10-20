import type {
  BankAccount, BankAccountListResponse, BankEntryListResponse, CreateBankAccountRequest, ImportStatementRequest,
  ImportStatementResponse, StatementLine, StatementLineListResponse, UpdateBankAccountRequest,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/**
 * A branch's bank accounts and their reconciliation (#21), typed with their
 * @bms/shared contracts. The API answers only with FEATURE_BANK_ACCOUNTS=true.
 */

type Paging = { page?: number; pageSize?: number };

const accounts = (branchId: number) => `/branches/${branchId}/bank-accounts`;
const account = (branchId: number, id: number) => `${accounts(branchId)}/${id}`;

export const listAccounts = (branchId: number, params: Paging) => api.get<BankAccountListResponse>(`${accounts(branchId)}${toQuery(params)}`);

export const createAccount = (branchId: number, body: Omit<CreateBankAccountRequest, 'currency'>) => api.post<BankAccount>(accounts(branchId), body);

/** Number and IBAN change only while no money has moved through the account. */
export const updateAccount = (branchId: number, id: number, body: UpdateBankAccountRequest) => api.put<BankAccount>(account(branchId, id), body);

export const setAccountActive = (branchId: number, id: number, active: boolean) =>
  api.post<BankAccount>(`${account(branchId, id)}/${active ? 'reactivate' : 'deactivate'}`);

export type EntriesParams = Paging & { status?: 'uncleared' | 'cleared'; amount?: string; direction?: 'in' | 'out' };

/** The system's bank movements; with amount and direction, the ones a statement line can be matched to. */
export const listEntries = (branchId: number, id: number, params: EntriesParams) =>
  api.get<BankEntryListResponse>(`${account(branchId, id)}/entries${toQuery(params)}`);

export type LinesParams = Paging & { matched?: 'true' | 'false' };

export const listLines = (branchId: number, id: number, params: LinesParams) =>
  api.get<StatementLineListResponse>(`${account(branchId, id)}/statement-lines${toQuery(params)}`);

export const importStatement = (branchId: number, id: number, body: ImportStatementRequest) =>
  api.post<ImportStatementResponse>(`${account(branchId, id)}/statement-lines`, body);

export const matchLine = (branchId: number, id: number, lineId: string, entryId: string) =>
  api.post<StatementLine>(`${account(branchId, id)}/statement-lines/${lineId}/match`, { entryId });

export const unmatchLine = (branchId: number, id: number, lineId: string) =>
  api.post<StatementLine>(`${account(branchId, id)}/statement-lines/${lineId}/unmatch`);
