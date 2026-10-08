// Shared types across API and Web

export type Role =
  | 'Super_Admin'
  | 'Admin'
  | 'Manager'
  | 'Finance_Officer'
  | 'Stock_Clerk'
  | 'Sales'
  | 'Purchasor';

/** The API error envelope; defined by ErrorResponseSchema in common.ts. */
export type { ErrorResponse as ApiError } from './common.js';

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export * from './common.js';
export * from './health.js';
export * from './order.js';
export * from './supplier.js';
export { Money } from './money.js';
export type { MoneyInput } from './money.js';
