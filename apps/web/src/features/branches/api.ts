import type { Branch, BranchListResponse, CreateBranchRequest, MessageResponse } from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The branch endpoints (#21), typed with their @bms/shared contracts. */

export interface BranchListParams {
  page?: number;
  pageSize?: number;
  isActive?: 'true' | 'false';
}

export type BranchAction = 'deactivate' | 'reactivate';

export const listBranches = (params: BranchListParams) => api.get<BranchListResponse>(`/branches${toQuery({ ...params })}`);

/** The request body leaves the opening hours to the API's default. */
export const createBranch = (body: Omit<CreateBranchRequest, 'operatingHours'>) => api.post<Branch>('/branches', body);

export const runBranchAction = (id: number, action: BranchAction) => api.post<MessageResponse>(`/branches/${id}/${action}`);

export const deleteBranch = (id: number) => api.delete<MessageResponse>(`/branches/${id}`);
