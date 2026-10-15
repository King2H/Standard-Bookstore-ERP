import type {
  CreateStaffRequest, MessageResponse, SetStaffLocationsRequest, SetStaffRolesRequest, StaffListResponse,
  StaffLocationListResponse,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The staff administration endpoints (#21, auth part 2), typed with their @bms/shared contracts. */

export interface StaffListParams {
  page?: number;
  pageSize?: number;
}

export type StaffAction = 'deactivate' | 'reactivate' | 'unlock';

export const listStaff = (params: StaffListParams) => api.get<StaffListResponse>(`/staff${toQuery({ ...params })}`);

export const createStaff = (body: CreateStaffRequest) => api.post<{ staffId: number }>('/staff', body);

export const runStaffAction = (id: number, action: StaffAction) => api.post<MessageResponse>(`/staff/${id}/${action}`);

export const setStaffRoles = (id: number, roles: SetStaffRolesRequest) => api.put<MessageResponse>(`/staff/${id}/roles`, roles);

export const setAllBranches = (id: number, isAllBranches: boolean) =>
  api.put<MessageResponse>(`/staff/${id}/all-branches`, { isAllBranches });

export const resetPassword = (id: number, temporaryPassword: string) =>
  api.post<MessageResponse>(`/staff/${id}/reset-password`, { temporaryPassword });

export const getStaffLocations = (id: number) => api.get<StaffLocationListResponse>(`/staff/${id}/locations`);

export const setStaffLocations = (id: number, locationIds: SetStaffLocationsRequest) =>
  api.put<MessageResponse>(`/staff/${id}/locations`, locationIds);
