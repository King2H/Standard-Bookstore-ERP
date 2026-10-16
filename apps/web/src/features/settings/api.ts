import type {
  BranchConfigListResponse, ConfigEntry, EffectiveConfigResponse, MessageResponse, SystemConfigListResponse,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** System settings and branch overrides (#21), typed with their @bms/shared contracts. */

export const listSystemConfig = () => api.get<SystemConfigListResponse>('/config/system');

/** The values in effect in the session's branch; open to all staff. */
export const getEffectiveConfig = (keys: string[]) => api.get<EffectiveConfigResponse>(`/config/effective${toQuery({ keys: keys.join(',') })}`);

export const listBranchConfig = (branchId: number) => api.get<BranchConfigListResponse>(`/config/branches/${branchId}`);

export const setSystemConfig = (key: string, value: unknown) => api.put<ConfigEntry>(`/config/system/${key}`, { value });

export const setBranchConfig = (branchId: number, key: string, value: unknown) =>
  api.put<ConfigEntry>(`/config/branches/${branchId}/${key}`, { value });

export const removeBranchOverride = (branchId: number, key: string) =>
  api.delete<MessageResponse>(`/config/branches/${branchId}/${key}`);
