import { z } from 'zod';
import { IdSchema, ListPagingQuerySchema, MoneyInputSchema, PaginatedSchema } from './common.js';

/**
 * Contracts for a branch's bank accounts and their reconciliation,
 * /api/v1/branches/{branchId}/bank-accounts (#21). The module is on only with
 * FEATURE_BANK_ACCOUNTS=true until feature flags (#27).
 */

const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date, YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a calendar date');

const PositiveMoneySchema = MoneyInputSchema.refine((v) => Number(v) > 0, 'Must be more than zero').refine(
  (v) => /^\d+(\.\d{1,2})?$/.test(String(v)),
  'At most two decimals',
);

export const BankAccountBranchParamsSchema = z.object({ branchId: IdSchema });
export const BankAccountParamsSchema = z.object({ branchId: IdSchema, id: IdSchema });
export const StatementLineParamsSchema = z.object({ branchId: IdSchema, id: IdSchema, lineId: IdSchema });

export const BankAccountSchema = z.object({
  id: z.number().int(),
  branchId: z.number().int(),
  accountName: z.string(),
  bankName: z.string(),
  /** ****1234; the number itself is never sent. */
  accountNumberMasked: z.string(),
  ibanMasked: z.string().nullable(),
  currency: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  /** Money has moved through it, so its number and currency can no longer change. */
  hasMovements: z.boolean(),
});
export type BankAccount = z.infer<typeof BankAccountSchema>;

export const BankAccountListQuerySchema = ListPagingQuerySchema.extend({
  isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export const BankAccountListResponseSchema = PaginatedSchema(BankAccountSchema);
export type BankAccountListResponse = z.infer<typeof BankAccountListResponseSchema>;

/** Digits and letters, with spaces or dashes between groups. */
const AccountNumberSchema = z
  .string()
  .trim()
  .min(4)
  .max(34)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/, 'Letters and digits, with spaces or dashes between groups');

export const CreateBankAccountRequestSchema = z.object({
  accountName: z.string().trim().min(1).max(100),
  bankName: z.string().trim().min(1).max(100),
  accountNumber: AccountNumberSchema,
  iban: AccountNumberSchema.nullable().optional(),
  /** Accounts are in ETB (owner decision 3a; foreign currency: #106). */
  currency: z.literal('ETB').default('ETB'),
});
export type CreateBankAccountRequest = z.infer<typeof CreateBankAccountRequestSchema>;

/** Number, IBAN and currency change only while no money has moved through the account. */
export const UpdateBankAccountRequestSchema = z
  .object({
    accountName: z.string().trim().min(1).max(100),
    bankName: z.string().trim().min(1).max(100),
    accountNumber: AccountNumberSchema,
    iban: AccountNumberSchema.nullable(),
    currency: z.literal('ETB'),
  })
  .partial();
export type UpdateBankAccountRequest = z.infer<typeof UpdateBankAccountRequestSchema>;

/** A bank movement the system recorded: a payment in, or a refund or supplier payment out. */
export const BankEntrySchema = z.object({
  id: z.string(),
  bankAccountId: z.number().int(),
  sourceType: z.string(),
  sourceId: z.string(),
  amount: z.number(),
  direction: z.enum(['in', 'out']),
  /** cleared once matched to a statement line. */
  status: z.enum(['uncleared', 'cleared']),
  notes: z.string().nullable(),
  createdAt: z.string(),
});
export type BankEntry = z.infer<typeof BankEntrySchema>;

export const BankEntryListQuerySchema = ListPagingQuerySchema.extend({
  status: z.enum(['uncleared', 'cleared']).optional(),
});
export const BankEntryListResponseSchema = PaginatedSchema(BankEntrySchema);

/** A line of the bank's statement. */
export const StatementLineSchema = z.object({
  id: z.string(),
  bankAccountId: z.number().int(),
  statementDate: z.string(),
  amount: z.number(),
  direction: z.enum(['in', 'out']),
  reference: z.string().nullable(),
  description: z.string().nullable(),
  /** The movement it is matched to. */
  entryId: z.string().nullable(),
  matchedAt: z.string().nullable(),
  importedAt: z.string(),
});
export type StatementLine = z.infer<typeof StatementLineSchema>;

export const StatementLineListQuerySchema = ListPagingQuerySchema.extend({
  matched: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export const StatementLineListResponseSchema = PaginatedSchema(StatementLineSchema);

export const StatementLineInputSchema = z.object({
  statementDate: DateOnlySchema,
  amount: PositiveMoneySchema,
  direction: z.enum(['in', 'out']),
  /** The bank's reference; a line whose reference was imported before is skipped. */
  reference: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional(),
});

export const ImportStatementRequestSchema = z.object({
  lines: z.array(StatementLineInputSchema).min(1).max(1000),
});
export type ImportStatementRequest = z.infer<typeof ImportStatementRequestSchema>;

export const ImportStatementResponseSchema = z.object({
  imported: z.number().int(),
  /** Matched on import: exactly one movement of the same amount and direction within 3 days. */
  matched: z.number().int(),
  /** Skipped: their reference was imported before. */
  duplicates: z.number().int(),
});

export const MatchStatementLineRequestSchema = z.object({ entryId: z.coerce.string().regex(/^\d+$/) });
