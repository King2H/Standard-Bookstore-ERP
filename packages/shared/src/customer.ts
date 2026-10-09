import { z } from 'zod';
import { IdSchema, LifecycleStatusSchema, ListPagingQuerySchema, MoneyInputSchema } from './common.js';

/** Contracts for /api/v1/customers and /api/v1/customer-groups (#21). */

export const CustomerGroupRefSchema = z.object({ id: z.number().int(), name: z.string(), discountPct: z.number() });

export const CustomerSchema = z.object({
  id: z.number().int(),
  /** Home branch; customers are shared by every branch. */
  branchId: z.number().int().nullable(),
  customerCode: z.string(),
  fullName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  gender: z.string().nullable(),
  /** YYYY-MM-DD. */
  dateOfBirth: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  isActive: z.boolean(),
  status: LifecycleStatusSchema,
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  loyaltyBalance: z.number(),
  lifetimePoints: z.number(),
  storeCreditBalance: z.number(),
  /** What the customer owes the store across all unsettled receivables. */
  outstandingReceivables: z.number(),
  groups: z.array(CustomerGroupRefSchema),
});
export type Customer = z.infer<typeof CustomerSchema>;

const BooleanQuerySchema = z.enum(['true', 'false']).transform((v) => v === 'true');

export const CustomerListQuerySchema = ListPagingQuerySchema.extend({
  /** Name, phone, email or customer code. */
  q: z.string().optional(),
  /** Home branch. */
  branchId: IdSchema.optional(),
  isActive: BooleanQuerySchema.optional(),
  /** Lifecycle filter; when present it replaces `isActive`. */
  status: z.enum(['active', 'inactive', 'archived', 'all']).optional(),
  groupId: IdSchema.optional(),
});
export type CustomerListQuery = z.infer<typeof CustomerListQuerySchema>;

export const CustomerListResponseSchema = z.object({
  items: z.array(CustomerSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type CustomerListResponse = z.infer<typeof CustomerListResponseSchema>;

const optionalText = z.string().nullable().optional();

export const CreateCustomerRequestSchema = z.object({
  fullName: z.string().trim().min(1),
  phone: optionalText,
  email: optionalText,
  gender: optionalText,
  dateOfBirth: optionalText,
  address: optionalText,
  city: optionalText,
  branchId: IdSchema.nullable().optional(),
});
export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequestSchema>;

export const UpdateCustomerRequestSchema = CreateCustomerRequestSchema.extend({
  fullName: z.string().trim().min(1).optional(),
});
export type UpdateCustomerRequest = z.infer<typeof UpdateCustomerRequestSchema>;

export const CustomerGroupSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  discountPct: z.number(),
});
export type CustomerGroup = z.infer<typeof CustomerGroupSchema>;

export const CustomerGroupListResponseSchema = z.object({ items: z.array(CustomerGroupSchema) });
export type CustomerGroupListResponse = z.infer<typeof CustomerGroupListResponseSchema>;

export const CreateCustomerGroupRequestSchema = z.object({
  name: z.string().trim().min(1),
  description: optionalText,
  discountPct: z.number().min(0).max(100).optional(),
});
export type CreateCustomerGroupRequest = z.infer<typeof CreateCustomerGroupRequestSchema>;

export const LoyaltyBalanceSchema = z.object({ loyaltyBalance: z.number(), lifetimePoints: z.number() });
export type LoyaltyBalance = z.infer<typeof LoyaltyBalanceSchema>;

export const LoyaltyHistoryEntrySchema = z.object({
  /** A bigint, sent as a string. */
  id: z.string(),
  customerId: z.number().int(),
  transactionRef: z.string().nullable(),
  pointsDelta: z.number(),
  /** ACCRUAL, REDEMPTION, ... */
  reason: z.string(),
  createdAt: z.string(),
});

export const LoyaltyHistoryResponseSchema = z.object({
  items: z.array(LoyaltyHistoryEntrySchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type LoyaltyHistoryResponse = z.infer<typeof LoyaltyHistoryResponseSchema>;

/** A back-office correction; customers spend points as a payment at checkout. */
export const RedeemPointsRequestSchema = z.object({
  points: z.number().int().positive(),
  /** Why the points are taken off by hand; kept in the audit log. */
  reason: z.string().trim().min(1).max(500),
  transactionRef: z.string().nullable().optional(),
});
export type RedeemPointsRequest = z.infer<typeof RedeemPointsRequestSchema>;

export const StoreCreditBalanceSchema = z.object({ balance: z.number() });
export type StoreCreditBalance = z.infer<typeof StoreCreditBalanceSchema>;

export const StoreCreditHistoryEntrySchema = z.object({
  /** A bigint, sent as a string. */
  id: z.string(),
  customerId: z.number().int(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  amount: z.number(),
  direction: z.enum(['credit', 'debit']),
  createdAt: z.string(),
});

export const StoreCreditHistoryResponseSchema = z.object({
  items: z.array(StoreCreditHistoryEntrySchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type StoreCreditHistoryResponse = z.infer<typeof StoreCreditHistoryResponseSchema>;

/** A back-office correction; customers spend store credit as a payment at checkout. */
export const AdjustStoreCreditRequestSchema = z.object({
  /** More than zero; the direction says which way it goes. */
  amount: MoneyInputSchema,
  direction: z.enum(['credit', 'debit']),
  /** Why the balance is changed by hand; kept in the audit log. */
  reason: z.string().trim().min(1).max(500),
  refType: z.string().nullable().optional(),
  refId: z.string().nullable().optional(),
});
export type AdjustStoreCreditRequest = z.infer<typeof AdjustStoreCreditRequestSchema>;
