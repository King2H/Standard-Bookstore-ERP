import type { ProfileResponse } from '@bms/shared';
import { api } from '../../lib/api.js';

/** The signed-in account: roles in the session branch, the session branch, access to all branches. */
export const getMyProfile = () => api.get<ProfileResponse>('/staff/me');
