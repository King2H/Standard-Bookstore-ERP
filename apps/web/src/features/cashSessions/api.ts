import type {
  CashMovementRequest, CashSessionDetail, CashSessionListResponse, CashSessionStatus, CloseCashSessionRequest,
  CurrentCashSessionResponse, OpenCashSessionRequest,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The cash session endpoints (#171), typed with their @bms/shared contracts. Sessions are the session branch's. */

export type CashSessionParams = { status?: CashSessionStatus; staffId?: number; page?: number; pageSize?: number };

/** The signed-in staff member's open session, and whether the branch takes cash only with one. */
export const getCurrentCashSession = () => api.get<CurrentCashSessionResponse>('/cash-sessions/current');

export const listCashSessions = (params: CashSessionParams) => api.get<CashSessionListResponse>(`/cash-sessions${toQuery(params)}`);

export const getCashSession = (id: number) => api.get<CashSessionDetail>(`/cash-sessions/${id}`);

export const openCashSession = (body: OpenCashSessionRequest) => api.post<CashSessionDetail>('/cash-sessions', body);

/** Cash put in or taken out of one's own open session, with a type and a reason. */
export const addCashMovement = (id: number, body: CashMovementRequest) => api.post<CashSessionDetail>(`/cash-sessions/${id}/movements`, body);

/** The blind count; beyond the branch's limit the session waits for review. */
export const closeCashSession = (id: number, body: CloseCashSessionRequest) => api.post<CashSessionDetail>(`/cash-sessions/${id}/close`, body);

export const reviewCashSession = (id: number, reason: string) => api.post<CashSessionDetail>(`/cash-sessions/${id}/review`, { reason });
