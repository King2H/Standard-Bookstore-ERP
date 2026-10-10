import { z } from 'zod';
import { IdSchema, ListPagingQuerySchema, MoneyInputSchema } from './common.js';

/** Contracts for /api/v1/purchase-orders: buying stock from suppliers (#21). */

export const PurchaseOrderStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'approved',
  'ordered',
  'partially_received',
  'received',
  'closed',
  'cancelled',
]);
export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatusSchema>;

export const PurchaseOrderLineSchema = z.object({
  id: z.string(),
  poId: z.string(),
  bookId: z.number().int(),
  bookTitle: z.string(),
  bookIsbn: z.string(),
  formatId: z.number().int().nullable(),
  editionId: z.number().int().nullable(),
  quantity: z.number().int(),
  unitCost: z.number(),
  receivedQuantity: z.number().int(),
  /** Still expected: nothing once the order is closed or cancelled. */
  remaining: z.number().int(),
});

export const PurchaseOrderReceiptSchema = z.object({
  id: z.string(),
  poId: z.string(),
  locationId: z.number().int(),
  locationName: z.string(),
  receivedBy: z.number().int(),
  receivedAt: z.string(),
  notes: z.string().nullable(),
  items: z.array(
    z.object({
      id: z.string(),
      receiptId: z.string(),
      poLineItemId: z.string(),
      bookTitle: z.string(),
      quantityReceived: z.number().int(),
    }),
  ),
});

/** The payment-method codes the rest of the system uses, and cheque (owner decision 3a). */
export const SupplierPaymentMethodSchema = z.enum(['cash', 'bank', 'mobile', 'cheque']);
export type SupplierPaymentMethod = z.infer<typeof SupplierPaymentMethodSchema>;

export const SupplierPaymentSchema = z.object({
  id: z.string(),
  /** SPAY-YYYYMMDD-NNNN. */
  paymentNumber: z.string().nullable(),
  poId: z.string(),
  amount: z.number(),
  paymentMethod: z.string(),
  /** auto_on_receipt: a cash-terms order paying for what arrived. */
  source: z.enum(['manual', 'auto_on_receipt']),
  notes: z.string().nullable(),
  createdBy: z.number().int(),
  createdAt: z.string(),
  /** A reversed payment no longer counts as paid (owner decision 1a). */
  reversedAt: z.string().nullable(),
  reversedBy: z.number().int().nullable(),
  reversalReason: z.string().nullable(),
});

export const SupplierCreditNoteSchema = z.object({
  id: z.string(),
  /** SCN-YYYYMMDD-NNNN. */
  creditNoteNumber: z.string().nullable(),
  poId: z.string(),
  supplierId: z.number().int(),
  amount: z.number(),
  reason: z.string(),
  createdBy: z.number().int(),
  createdAt: z.string(),
});

export const PurchaseOrderSchema = z.object({
  /** A bigint, sent as a string. */
  id: z.string(),
  /** PO-000123. */
  poNumber: z.string(),
  /** The ordering branch: it buys, approves and pays (owner decision 1a). */
  branchId: z.number().int(),
  supplierId: z.number().int(),
  supplierName: z.string(),
  status: PurchaseOrderStatusSchema,
  /** What was ordered. */
  totalAmount: z.number(),
  /** Always ETB (owner decision 6a). */
  currency: z.string(),
  /** YYYY-MM-DD. */
  expectedDeliveryDate: z.string().nullable(),
  notes: z.string().nullable(),
  /** The branch that receives the goods (owner decision 1a). */
  receivingBranchId: z.number().int(),
  receivingLocationId: z.number().int().nullable(),
  receivingLocationName: z.string().nullable(),
  financialStatus: z.enum(['unpaid', 'partial', 'paid']),
  /** cash settles on receipt; credit waits for a supplier payment. */
  paymentTerms: z.enum(['cash', 'credit']),
  createdBy: z.number().int(),
  approvedBy: z.number().int().nullable(),
  /** Why a part-received order was closed short (owner decision 3a). */
  closedReason: z.string().nullable(),
  closedBy: z.number().int().nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** What the received goods are worth: the amount owed to the supplier. */
  receivedValue: z.number(),
  amountPaid: z.number(),
  creditNotesTotal: z.number(),
  /** receivedValue − amountPaid − creditNotesTotal; below zero is an advance. */
  outstandingAmount: z.number(),
  orderedQuantityTotal: z.number().int(),
  receivedQuantityTotal: z.number().int(),
  /** On a single order only. */
  lineItems: z.array(PurchaseOrderLineSchema).optional(),
  receipts: z.array(PurchaseOrderReceiptSchema).optional(),
  payments: z.array(SupplierPaymentSchema).optional(),
  creditNotes: z.array(SupplierCreditNoteSchema).optional(),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;

/** A calendar date, YYYY-MM-DD, that exists. */
const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date, YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a calendar date');

export const PurchaseOrderListQuerySchema = ListPagingQuerySchema.extend({
  status: PurchaseOrderStatusSchema.optional(),
  supplierId: IdSchema.optional(),
  /** From this day on. */
  dateFrom: DateOnlySchema.optional(),
  /** Up to and including this day. */
  dateTo: DateOnlySchema.optional(),
});
export type PurchaseOrderListQuery = z.infer<typeof PurchaseOrderListQuerySchema>;

export const PurchaseOrderListResponseSchema = z.object({
  items: z.array(PurchaseOrderSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type PurchaseOrderListResponse = z.infer<typeof PurchaseOrderListResponseSchema>;

export const PurchaseOrderLineInputSchema = z.object({
  bookId: IdSchema,
  formatId: IdSchema.nullable().optional(),
  editionId: IdSchema.nullable().optional(),
  quantity: z.number().int().positive(),
  /** Zero for free copies (owner decision 5a). */
  unitCost: MoneyInputSchema.refine((v) => Number(v) >= 0, 'Cannot be negative'),
});
export type PurchaseOrderLineInput = z.infer<typeof PurchaseOrderLineInputSchema>;

/** Orders are in ETB; an old client may still send it. */
const CurrencySchema = z.literal('ETB', { error: 'Purchase orders are in ETB' });

export const CreatePurchaseOrderRequestSchema = z.object({
  supplierId: IdSchema,
  /** The session branch; another is refused. */
  branchId: IdSchema.optional(),
  /** Defaults to the ordering branch. */
  receivingBranchId: IdSchema.nullable().optional(),
  /** Defaults to the receiving branch's default location. */
  receivingLocationId: IdSchema.nullable().optional(),
  currency: CurrencySchema.optional(),
  expectedDeliveryDate: DateOnlySchema.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  paymentTerms: z.enum(['cash', 'credit']).default('credit'),
  lineItems: z.array(PurchaseOrderLineInputSchema).min(1, 'At least one line item is required'),
});
export type CreatePurchaseOrderRequest = z.infer<typeof CreatePurchaseOrderRequestSchema>;

/** A draft's changes; lineItems replaces every line. */
export const UpdatePurchaseOrderRequestSchema = z.object({
  supplierId: IdSchema.optional(),
  receivingBranchId: IdSchema.nullable().optional(),
  receivingLocationId: IdSchema.nullable().optional(),
  currency: CurrencySchema.optional(),
  expectedDeliveryDate: DateOnlySchema.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  paymentTerms: z.enum(['cash', 'credit']).optional(),
  lineItems: z.array(PurchaseOrderLineInputSchema).min(1, 'At least one line item is required').optional(),
});
export type UpdatePurchaseOrderRequest = z.infer<typeof UpdatePurchaseOrderRequestSchema>;

export const ReceivePurchaseOrderRequestSchema = z.object({
  /** A location of the receiving branch; defaults to the order's receiving location. */
  locationId: IdSchema.nullable().optional(),
  items: z
    .array(z.object({ poLineItemId: IdSchema, quantityReceived: z.number().int().positive() }))
    .min(1, 'At least one item must be received'),
  notes: z.string().max(2000).nullable().optional(),
});
export type ReceivePurchaseOrderRequest = z.infer<typeof ReceivePurchaseOrderRequestSchema>;

export const ClosePurchaseOrderRequestSchema = z
  .object({
    /** Required to close a part-received order short. */
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .default({});
export type ClosePurchaseOrderRequest = z.infer<typeof ClosePurchaseOrderRequestSchema>;

// ── Supplier payables ─────────────────────────────────────────────────────────

/** A positive amount in whole cents. */
const PayableAmountSchema = MoneyInputSchema.refine((v) => Number(v) > 0, 'Must be more than zero').refine(
  (v) => /^\d+(\.\d{1,2})?$/.test(String(v)),
  'At most two decimals',
);

export const CreateSupplierPaymentRequestSchema = z.object({
  amount: PayableAmountSchema,
  paymentMethod: SupplierPaymentMethodSchema.default('cash'),
  notes: z.string().max(1000).nullable().optional(),
});
export type CreateSupplierPaymentRequest = z.infer<typeof CreateSupplierPaymentRequestSchema>;

export const ReverseSupplierPaymentRequestSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(1000),
});
export type ReverseSupplierPaymentRequest = z.infer<typeof ReverseSupplierPaymentRequestSchema>;

export const SupplierPaymentParamsSchema = z.object({ id: IdSchema, paymentId: IdSchema });

export const CreateSupplierCreditNoteRequestSchema = z.object({
  amount: PayableAmountSchema,
  reason: z.string().trim().min(1, 'A reason is required').max(1000),
});
export type CreateSupplierCreditNoteRequest = z.infer<typeof CreateSupplierCreditNoteRequestSchema>;

export const SupplierLedgerQuerySchema = z.object({
  /** From this day on, in the database's calendar. */
  dateFrom: DateOnlySchema.optional(),
  /** Up to and including this day. */
  dateTo: DateOnlySchema.optional(),
  /** Staff with access to all branches: one branch; without it, all. */
  branchId: IdSchema.optional(),
});
export type SupplierLedgerQuery = z.infer<typeof SupplierLedgerQuerySchema>;

export const SupplierLedgerEntrySchema = z.object({
  /** YYYY-MM-DD, in the database's calendar. */
  date: z.string(),
  type: z.enum(['PO', 'GOODS_RECEIPT', 'PAYMENT', 'PAYMENT_REVERSAL', 'CREDIT_NOTE']),
  reference: z.string(),
  description: z.string(),
  /** + adds to what is owed (goods received, a reversed payment); − settles it. */
  amount: z.number(),
  /** What is owed after this entry; below zero is an advance. */
  balance: z.number(),
});
export type SupplierLedgerEntry = z.infer<typeof SupplierLedgerEntrySchema>;

export const SupplierLedgerResponseSchema = z.object({
  entries: z.array(SupplierLedgerEntrySchema),
  /** What is owed now, all dates included. */
  currentBalance: z.number(),
});
export type SupplierLedgerResponse = z.infer<typeof SupplierLedgerResponseSchema>;
