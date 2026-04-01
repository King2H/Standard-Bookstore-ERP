// Shared types across API and Web

export type Role =
  | 'Super_Admin'
  | 'Admin'
  | 'Manager'
  | 'Finance_Officer'
  | 'Stock_Clerk'
  | 'Sales'
  | 'Purchasor';

export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
  timestamp: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
