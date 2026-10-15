import type { Location, LocationListResponse, MessageResponse } from '@bms/shared';
import { api } from '../../lib/api.js';

/** A branch's stock locations (#21), typed with their @bms/shared contracts. */

const base = (branchId: number) => `/branches/${branchId}/locations`;

export const listLocations = (branchId: number) => api.get<LocationListResponse>(base(branchId));

export const createLocation = (branchId: number, name: string) => api.post<Location>(base(branchId), { name });

export const renameLocation = (branchId: number, id: number, name: string) => api.put<Location>(`${base(branchId)}/${id}`, { name });

export const setDefaultLocation = (branchId: number, id: number) => api.put<Location>(`${base(branchId)}/${id}/set-default`, {});

export const deleteLocation = (branchId: number, id: number) => api.delete<MessageResponse>(`${base(branchId)}/${id}`);
