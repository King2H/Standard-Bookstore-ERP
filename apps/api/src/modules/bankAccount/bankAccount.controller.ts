import type { Request, Response } from 'express';
import {
  BankAccountBranchParamsSchema,
  BankAccountListQuerySchema,
  BankAccountParamsSchema,
  BankEntryListQuerySchema,
  CreateBankAccountRequestSchema,
  ImportStatementRequestSchema,
  MatchStatementLineRequestSchema,
  Money,
  StatementLineListQuerySchema,
  StatementLineParamsSchema,
  UpdateBankAccountRequestSchema,
  type BankAccount,
  type BankEntry,
  type StatementLine,
} from '@bms/shared';
import { AppError } from '../../lib/errors.js';
import { maskLast4 } from '../../lib/encryption.js';
import { valid } from '../../middleware/validate.js';
import * as service from './bankAccount.service.js';
import type { Actor, BankAccountRecord, BankEntryRecord, StatementLineRecord } from './bankAccount.types.js';

/**
 * HTTP side of bank accounts and reconciliation (A3): validated request ->
 * service -> response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { params: BankAccountBranchParamsSchema, query: BankAccountListQuerySchema },
  create: { params: BankAccountBranchParamsSchema, body: CreateBankAccountRequestSchema },
  byId: { params: BankAccountParamsSchema },
  update: { params: BankAccountParamsSchema, body: UpdateBankAccountRequestSchema },
  entries: { params: BankAccountParamsSchema, query: BankEntryListQuerySchema },
  lines: { params: BankAccountParamsSchema, query: StatementLineListQuerySchema },
  importStatement: { params: BankAccountParamsSchema, body: ImportStatementRequestSchema },
  match: { params: StatementLineParamsSchema, body: MatchStatementLineRequestSchema },
  unmatch: { params: StatementLineParamsSchema },
};

function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

function toAccount(a: BankAccountRecord): BankAccount {
  return {
    id: a.id,
    branchId: a.branchId,
    accountName: a.accountName,
    bankName: a.bankName,
    accountNumberMasked: maskLast4(a.accountNumber),
    ibanMasked: a.iban ? maskLast4(a.iban) : null,
    currency: a.currency,
    isActive: a.isActive,
    createdAt: a.createdAt.toISOString(),
    hasMovements: a.hasMovements,
  };
}

function toEntry(e: BankEntryRecord): BankEntry {
  return {
    id: e.id,
    bankAccountId: e.bankAccountId,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    amount: e.amount.toNumber(),
    direction: e.direction,
    status: e.status,
    notes: e.notes,
    createdAt: e.createdAt.toISOString(),
  };
}

function toLine(l: StatementLineRecord): StatementLine {
  return {
    id: l.id,
    bankAccountId: l.bankAccountId,
    statementDate: l.statementDate,
    amount: l.amount.toNumber(),
    direction: l.direction,
    reference: l.reference,
    description: l.description,
    entryId: l.entryId,
    matchedAt: l.matchedAt?.toISOString() ?? null,
    importedAt: l.importedAt.toISOString(),
  };
}

function paged<T, R>(result: { items: T[]; total: number }, query: { page: number; pageSize: number }, map: (t: T) => R) {
  return {
    items: result.items.map(map),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.ceil(result.total / query.pageSize),
  };
}

const pageOf = (query: { page: number; pageSize: number }) => ({ limit: query.pageSize, offset: (query.page - 1) * query.pageSize });

export async function list(req: Request, res: Response): Promise<void> {
  const { params, query } = valid(req, schemas.list);
  res.json(paged(await service.listAccounts(params.branchId, query.isActive, pageOf(query)), query, toAccount));
}

export async function create(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.create);
  res.status(201).json(toAccount(await service.createAccount(actor(req), params.branchId, body)));
}

export async function getById(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.byId);
  res.json(toAccount(await service.getAccount(params.branchId, params.id)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.update);
  res.json(toAccount(await service.updateAccount(actor(req), params.branchId, params.id, body)));
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.byId);
  res.json(toAccount(await service.setActive(actor(req), params.branchId, params.id, false)));
}

export async function reactivate(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.byId);
  res.json(toAccount(await service.setActive(actor(req), params.branchId, params.id, true)));
}

export async function entries(req: Request, res: Response): Promise<void> {
  const { params, query } = valid(req, schemas.entries);
  const filter = { status: query.status, amount: query.amount === undefined ? undefined : Money.of(query.amount), direction: query.direction };
  res.json(paged(await service.listEntries(params.branchId, params.id, filter, pageOf(query)), query, toEntry));
}

export async function lines(req: Request, res: Response): Promise<void> {
  const { params, query } = valid(req, schemas.lines);
  res.json(paged(await service.listLines(params.branchId, params.id, query.matched, pageOf(query)), query, toLine));
}

export async function importStatement(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.importStatement);
  const result = await service.importStatement(
    actor(req),
    params.branchId,
    params.id,
    body.lines.map((l) => ({
      statementDate: l.statementDate,
      amount: Money.of(l.amount),
      direction: l.direction,
      reference: l.reference ?? null,
      description: l.description ?? null,
    })),
  );
  res.status(201).json(result);
}

export async function match(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.match);
  await service.matchLine(actor(req), params.branchId, params.id, String(params.lineId), body.entryId);
  res.json({ message: 'Matched' });
}

export async function unmatch(req: Request, res: Response): Promise<void> {
  const { params } = valid(req, schemas.unmatch);
  await service.unmatchLine(actor(req), params.branchId, params.id, String(params.lineId));
  res.json({ message: 'Unmatched' });
}

/** Retired (#21, owner decision 1a): statement lines and movements are kept apart and matched. */
export function reconciliationRetired(): never {
  throw new AppError(
    'DEPRECATED',
    'The /branches/{branchId}/reconciliation endpoints are no longer supported. Use /branches/{branchId}/bank-accounts/{id}/statement-lines and /entries.',
    410,
  );
}
