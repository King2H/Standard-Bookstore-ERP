import type {
  ReceiveTransferRequest, ResolveTransferRequest, Transfer, TransferListResponse, TransferRequest, TransferStatus,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The transfer endpoints (#170), typed with their @bms/shared contracts. Notes are the session branch's, sent or received. */

export type TransferParams = {
  direction?: 'outgoing' | 'incoming';
  status?: TransferStatus;
  page?: number;
  pageSize?: number;
};

export const listTransfers = (params: TransferParams) => api.get<TransferListResponse>(`/transfers${toQuery(params)}`);

export const getTransfer = (id: number) => api.get<Transfer>(`/transfers/${id}`);

/** A draft from a location of the session's branch to another branch. */
export const createTransfer = (body: TransferRequest) => api.post<Transfer>('/transfers', body);

/** A draft, replaced whole. */
export const updateTransfer = (id: number, body: TransferRequest) => api.put<Transfer>(`/transfers/${id}`, body);

export const cancelTransfer = (id: number) => api.post<Transfer>(`/transfers/${id}/cancel`);

/** The copies leave the source at its average cost and are in transit. */
export const dispatchTransfer = (id: number) => api.post<Transfer>(`/transfers/${id}/dispatch`);

/** The receiving branch takes copies into one of its locations. */
export const receiveTransfer = (id: number, body: ReceiveTransferRequest) => api.post<Transfer>(`/transfers/${id}/receive`, body);

/** Copies that did not arrive: lost, damaged or returned, with a reason. */
export const resolveTransfer = (id: number, body: ResolveTransferRequest) => api.post<Transfer>(`/transfers/${id}/resolve`, body);
