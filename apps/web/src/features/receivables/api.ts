import type {
  Receivable, ReceivableDueDateRequest, ReceivableListResponse, ReceivableSourceType, ReceivableSummary,
  WriteOffReceivableRequest,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The receivable endpoints (#21), typed with their @bms/shared contracts. Collecting is done in Payments. */

/** `GET /receivables` filters, as they travel in the query string. The branch is the session's. */
export type ReceivablesParams = {
  page?: number;
  pageSize?: number;
  /** One status, or several separated by commas. */
  status?: string;
  sourceType?: ReceivableSourceType;
};

export const listReceivables = (params: ReceivablesParams) => api.get<ReceivableListResponse>(`/receivables${toQuery(params)}`);

/**
 * Totals of one branch. Named explicitly: with no branch, staff with access
 * to all branches would get every branch's totals beside a one-branch list.
 */
export const getReceivableSummary = (branchId: number) => api.get<ReceivableSummary>(`/receivables/summary${toQuery({ branchId })}`);

/** Closes what is still owed as bad debt; no payment is recorded. */
export const writeOffReceivable = (id: string, body: WriteOffReceivableRequest) => api.post<Receivable>(`/receivables/${id}/write-off`, body);

/** A new due date, or none; the status follows it. */
export const changeDueDate = (id: string, body: ReceivableDueDateRequest) => api.patch<Receivable>(`/receivables/${id}/due-date`, body);
