import { z } from 'zod';
import { IdSchema, ListPagingQuerySchema, MoneyInputSchema } from './common.js';

/** Contracts for /api/v1/exchanges: books brought in for books taken out, at the counter (#21). */

export const ExchangeItemSchema = z.object({
  id: z.string(),
  exchangeId: z.string(),
  bookId: z.number().int(),
  bookTitle: z.string(),
  quantity: z.number().int(),
  /** Incoming: what each book was valued at; outgoing: its catalog price. */
  unitPrice: z.number(),
  totalPrice: z.number(),
  /** Incoming books: damaged ones are kept apart from stock for sale. */
  condition: z.enum(['resellable', 'damaged']).optional(),
});

export const ExchangeSettlementEntrySchema = z.object({
  id: z.string(),
  /** cash_payment: the customer paid; cash_refund: the store paid back. */
  entryType: z.string(),
  amount: z.number(),
  /** cash, bank, mobile, store_credit or loyalty_points. */
  method: z.string().nullable(),
  createdAt: z.string(),
});

export const ExchangeSchema = z.object({
  /** A bigint, sent as a string. */
  id: z.string(),
  /** EXC-YYYYMMDD-NNNN. */
  exchangeReference: z.string(),
  branchId: z.number().int(),
  locationId: z.number().int().nullable(),
  customerId: z.number().int().nullable(),
  /** Completed, or Cancelled (voided); Initiated and Evaluated only on retired lifecycle exchanges. */
  status: z.string(),
  /** Only on exchanges made through the retired lifecycle flow. */
  lifecycleStatus: z.string().nullable(),
  totalIncomingValue: z.number(),
  totalOutgoingValue: z.number(),
  /** Outgoing less incoming: above zero the customer owes, below zero the store does. */
  netBalance: z.number(),
  settlementType: z.enum(['Even', 'Customer_Pays', 'Store_Refunds']),
  /** How a store refund went back. */
  refundMethod: z.enum(['store_credit', 'cash']).nullable(),
  currency: z.string(),
  notes: z.string().nullable(),
  createdBy: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** What the customer still owes on credit. */
  outstandingAmount: z.number(),
  /** YYYY-MM-DD, of the credit left. */
  dueDate: z.string().nullable(),
  /** The receivable's status, or Settled / Pending. */
  settlementStatus: z.string(),
  /** Whether it can still be voided: completed today (owner decision 5a). */
  voidable: z.boolean(),
  voidedAt: z.string().nullable(),
  voidedBy: z.number().int().nullable(),
  voidReason: z.string().nullable(),
  /** On a single exchange only. */
  incomingItems: z.array(ExchangeItemSchema).optional(),
  outgoingItems: z.array(ExchangeItemSchema).optional(),
  settlementEntries: z.array(ExchangeSettlementEntrySchema).optional(),
});
export type Exchange = z.infer<typeof ExchangeSchema>;

/** A calendar date, YYYY-MM-DD, that exists. */
const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date, YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a calendar date');

export const ExchangeListQuerySchema = ListPagingQuerySchema.extend({
  customerId: IdSchema.optional(),
  status: z.enum(['Completed', 'Cancelled', 'Initiated', 'Evaluated']).optional(),
  /** From this day on. */
  dateFrom: DateOnlySchema.optional(),
  /** Up to and including this day. */
  dateTo: DateOnlySchema.optional(),
});
export type ExchangeListQuery = z.infer<typeof ExchangeListQuerySchema>;

export const ExchangeListResponseSchema = z.object({
  items: z.array(ExchangeSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type ExchangeListResponse = z.infer<typeof ExchangeListResponseSchema>;

const PositiveMoneySchema = MoneyInputSchema.refine((v) => Number(v) > 0, 'Must be more than zero').refine(
  (v) => /^\d+(\.\d{1,2})?$/.test(String(v)),
  'At most two decimals',
);

export const ExchangeIncomingItemInputSchema = z.object({
  bookId: IdSchema,
  quantity: z.number().int().positive(),
  /** What each book is worth to the store; at most its selling price (owner decision 4a). */
  unitPrice: PositiveMoneySchema,
  condition: z.enum(['resellable', 'damaged']).default('resellable'),
});

/** Outgoing books are priced from the catalog (owner decision 4a); a price sent by an old client is ignored. */
export const ExchangeOutgoingItemInputSchema = z.object({
  bookId: IdSchema,
  quantity: z.number().int().positive(),
});

export const ExchangePaymentInputSchema = z.object({
  method: z.enum(['cash', 'bank', 'mobile', 'store_credit', 'loyalty_points']),
  amount: PositiveMoneySchema,
  reference: z.string().max(200).optional(),
});

export const CreateExchangeRequestSchema = z
  .object({
    /** A location of the session branch; every exchange moves stock. */
    locationId: IdSchema,
    customerId: IdSchema.nullable().optional(),
    notes: z.string().max(1000).optional(),
    incomingItems: z.array(ExchangeIncomingItemInputSchema).default([]),
    outgoingItems: z.array(ExchangeOutgoingItemInputSchema).default([]),
    /** When the customer owes the difference: paid at the counter (owner decision 2a). */
    payments: z.array(ExchangePaymentInputSchema).default([]),
    /** Leave what is not paid on credit; needs a customer. */
    allowCredit: z.boolean().default(false),
    /** Of the credit left, today or later. */
    dueDate: DateOnlySchema.nullable().optional(),
    /** When the store owes the difference (owner decision 3a); store credit needs a customer. */
    refundMethod: z.enum(['store_credit', 'cash']).default('store_credit'),
  })
  .refine((b) => b.incomingItems.length + b.outgoingItems.length > 0, {
    message: 'Exchange must have at least one incoming or outgoing item',
    path: ['incomingItems'],
  });
export type CreateExchangeRequest = z.infer<typeof CreateExchangeRequestSchema>;

export const VoidExchangeRequestSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(1000),
});
export type VoidExchangeRequest = z.infer<typeof VoidExchangeRequestSchema>;
