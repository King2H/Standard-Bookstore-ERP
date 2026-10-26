import { z } from 'zod';
import { IdSchema, PaginatedSchema, PaginationQuerySchema } from './common.js';

/**
 * Contracts for /api/v1/transfers: books moving between branches on a
 * transfer note (#170, owner decisions 1a–6a, 2026-10-26). The sending
 * branch drafts and dispatches it; the receiving branch receives it line by
 * line; what did not arrive is resolved with a reason.
 */

export const TransferStatusSchema = z.enum(['draft', 'in_transit', 'partially_received', 'received', 'closed', 'cancelled']);
export type TransferStatus = z.infer<typeof TransferStatusSchema>;

/** What became of copies that did not arrive (decision 4a). */
export const TransferOutcomeSchema = z.enum(['lost', 'damaged', 'returned']);
export type TransferOutcome = z.infer<typeof TransferOutcomeSchema>;

export const TransferEventKindSchema = z.enum(['received', 'lost', 'damaged', 'returned']);
export type TransferEventKind = z.infer<typeof TransferEventKindSchema>;

export const TransferLineSchema = z.object({
  id: z.number().int(),
  bookId: z.number().int(),
  bookTitle: z.string(),
  isbn: z.string().nullable(),
  quantity: z.number().int(),
  /** The source's average cost when dispatched; null on a draft. */
  unitCost: z.number().nullable(),
  receivedQuantity: z.number().int(),
  lostQuantity: z.number().int(),
  damagedQuantity: z.number().int(),
  returnedQuantity: z.number().int(),
  /** Still on the way: sent, not yet received or resolved. 0 before dispatch. */
  outstandingQuantity: z.number().int(),
});
export type TransferLine = z.infer<typeof TransferLineSchema>;

/** A receipt or a resolution, in the order they happened. */
export const TransferEventSchema = z.object({
  id: z.number().int(),
  lineId: z.number().int(),
  bookTitle: z.string(),
  kind: TransferEventKindSchema,
  quantity: z.number().int(),
  /** Where the copies went; null when lost. */
  locationId: z.number().int().nullable(),
  locationName: z.string().nullable(),
  reason: z.string().nullable(),
  staffId: z.number().int(),
  staffName: z.string(),
  createdAt: z.string(),
});
export type TransferEvent = z.infer<typeof TransferEventSchema>;

export const TransferSchema = z.object({
  id: z.number().int(),
  /** TRF-YYYYMMDD-NNNN. */
  transferNumber: z.string(),
  fromBranchId: z.number().int(),
  fromBranchName: z.string(),
  fromLocationId: z.number().int(),
  fromLocationName: z.string(),
  toBranchId: z.number().int(),
  toBranchName: z.string(),
  status: TransferStatusSchema,
  notes: z.string().nullable(),
  /** What is on the way, at the cost it left at. */
  inTransitValue: z.number(),
  totalQuantity: z.number().int(),
  createdBy: z.number().int(),
  createdByName: z.string(),
  createdAt: z.string(),
  dispatchedBy: z.number().int().nullable(),
  dispatchedAt: z.string().nullable(),
  cancelledBy: z.number().int().nullable(),
  cancelledAt: z.string().nullable(),
  /** When every copy was received or resolved. */
  completedAt: z.string().nullable(),
  lines: z.array(TransferLineSchema),
  events: z.array(TransferEventSchema),
});
export type Transfer = z.infer<typeof TransferSchema>;

/** A note in a list: no lines or events. */
export const TransferSummarySchema = TransferSchema.omit({ lines: true, events: true });
export type TransferSummary = z.infer<typeof TransferSummarySchema>;

export const TransferListQuerySchema = PaginationQuerySchema.extend({
  /** outgoing: sent by the session's branch; incoming: sent to it; both when left out. */
  direction: z.enum(['outgoing', 'incoming']).optional(),
  status: TransferStatusSchema.optional(),
});
export type TransferListQuery = z.infer<typeof TransferListQuerySchema>;

export const TransferListResponseSchema = PaginatedSchema(TransferSummarySchema);
export type TransferListResponse = z.infer<typeof TransferListResponseSchema>;

const ReasonSchema = z.string().trim().min(1, 'A reason is required').max(500);

export const TransferLineInputSchema = z.object({
  bookId: IdSchema,
  quantity: z.number().int().positive(),
});

/** A draft: from a location of the session's branch to another branch. PUT replaces a draft whole. */
export const TransferRequestSchema = z
  .object({
    fromLocationId: IdSchema,
    toBranchId: IdSchema,
    lines: z.array(TransferLineInputSchema).min(1, 'At least one book is required').max(200),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((t) => new Set(t.lines.map((l) => l.bookId)).size === t.lines.length, {
    message: 'Each book once per transfer',
    path: ['lines'],
  });
export type TransferRequest = z.infer<typeof TransferRequestSchema>;

export const ReceiveTransferRequestSchema = z.object({
  /** A location of the receiving branch. */
  locationId: IdSchema,
  items: z
    .array(z.object({ lineId: IdSchema, quantity: z.number().int().positive() }))
    .min(1, 'At least one line is required')
    .refine((items) => new Set(items.map((i) => i.lineId)).size === items.length, 'Each line once per receipt'),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type ReceiveTransferRequest = z.infer<typeof ReceiveTransferRequestSchema>;

/**
 * Copies that did not arrive: lost or damaged, said by the receiving branch
 * (damaged into one of its locations, kept apart as damaged); returned, said
 * by the sending branch, into one of its locations.
 */
export const ResolveTransferRequestSchema = z
  .object({
    lineId: IdSchema,
    outcome: TransferOutcomeSchema,
    quantity: z.number().int().positive(),
    reason: ReasonSchema,
    locationId: IdSchema.optional(),
  })
  .refine((r) => (r.outcome === 'lost') === (r.locationId === undefined), {
    message: 'Damaged and returned copies go to a location; lost ones to none',
    path: ['locationId'],
  });
export type ResolveTransferRequest = z.infer<typeof ResolveTransferRequestSchema>;
