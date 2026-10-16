import type { z } from 'zod';
import type {
  AdjustStoreCreditRequest, CreateCustomerRequest, Customer, CustomerListQuerySchema, CustomerListResponse,
  LoyaltyHistoryResponse, MessageResponse, ReceivableListResponse, RedeemPointsRequest, StoreCreditHistoryResponse,
  UpdateCustomerRequest,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The customer endpoints (#21), typed with their @bms/shared contracts. */

/** `GET /customers` filters, as they travel in the query string. */
export type CustomerListParams = {
  q?: string;
  status?: z.input<typeof CustomerListQuerySchema>['status'];
  groupId?: number;
  page?: number;
  pageSize?: number;
};

/** A page of a customer's history. */
export interface HistoryPage { page: number; pageSize: number }

/** Status changes, each `POST /customers/{id}/{action}`. */
export type CustomerAction = 'deactivate' | 'activate' | 'archive' | 'restore';

export const listCustomers = (params: CustomerListParams) => api.get<CustomerListResponse>(`/customers${toQuery(params)}`);

export const getCustomer = (id: number) => api.get<Customer>(`/customers/${id}`);

export const createCustomer = (body: CreateCustomerRequest) => api.post<Customer>('/customers', body);

export const updateCustomer = (id: number, body: UpdateCustomerRequest) => api.put<Customer>(`/customers/${id}`, body);

export const runCustomerAction = (id: number, action: CustomerAction) => api.post<MessageResponse>(`/customers/${id}/${action}`);

export const getLoyaltyHistory = (id: number, page: HistoryPage) =>
  api.get<LoyaltyHistoryResponse>(`/customers/${id}/loyalty/history${toQuery({ ...page })}`);

export const getStoreCreditHistory = (id: number, page: HistoryPage) =>
  api.get<StoreCreditHistoryResponse>(`/customers/${id}/store-credit/history${toQuery({ ...page })}`);

/** Every receivable of the customer, settled ones too. */
export const getCustomerReceivables = (customerId: number, page: HistoryPage) =>
  api.get<ReceivableListResponse>(`/receivables${toQuery({ customerId, ...page })}`);

export const redeemPoints = (id: number, body: RedeemPointsRequest) => api.post<MessageResponse>(`/customers/${id}/loyalty/redeem`, body);

export const adjustStoreCredit = (id: number, body: AdjustStoreCreditRequest) =>
  api.post<MessageResponse>(`/customers/${id}/store-credit/adjust`, body);
