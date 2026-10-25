import type { Service, ServiceBranchFeeRequest, ServiceJob, ServiceJobStep, ServiceListResponse, ServiceRequest } from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The services endpoints (#169), typed with their @bms/shared contracts. Fees are the session branch's. */

export type ServiceParams = {
  q?: string;
  status?: 'active' | 'inactive' | 'archived' | 'all';
  page?: number;
  pageSize?: number;
};

export type ServiceAction = 'activate' | 'deactivate' | 'archive' | 'restore';

export const listServices = (params: ServiceParams) => api.get<ServiceListResponse>(`/services${toQuery(params)}`);

export const createService = (body: ServiceRequest) => api.post<Service>('/services', body);

export const updateService = (id: number, body: ServiceRequest) => api.put<Service>(`/services/${id}`, body);

export const runServiceAction = (id: number, action: ServiceAction) => api.post<Service>(`/services/${id}/${action}`);

/** The session branch's own fee (owner decision 2a). */
export const setBranchFee = (id: number, body: ServiceBranchFeeRequest) => api.put<Service>(`/services/${id}/branch-fee`, body);

/** Back to the shop's fee in the session branch. */
export const removeBranchFee = (id: number) => api.delete<Service>(`/services/${id}/branch-fee`);

/** Moves a binding job of the session branch one step on (#169 PR 2). */
export const stepJob = (id: number, step: ServiceJobStep) => api.post<ServiceJob>(`/service-jobs/${id}/${step}`);
