import type { Location, LocationListResponse, MessageResponse } from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** A branch's stock locations (#21), typed with their @bms/shared contracts. */

const base = (branchId: number) => `/branches/${branchId}/locations`;

/** `all`: every location of the branch, also for staff limited to some (transfer destinations, #72). */
export const listLocations = (branchId: number, opts: { all?: boolean } = {}) =>
  api.get<LocationListResponse>(`${base(branchId)}${toQuery({ all: opts.all ? 'true' : undefined })}`);

export const createLocation = (branchId: number, name: string) => api.post<Location>(base(branchId), { name });

export const renameLocation = (branchId: number, id: number, name: string) => api.put<Location>(`${base(branchId)}/${id}`, { name });

export const setDefaultLocation = (branchId: number, id: number) => api.put<Location>(`${base(branchId)}/${id}/set-default`, {});

export const deleteLocation = (branchId: number, id: number) => api.delete<MessageResponse>(`${base(branchId)}/${id}`);
