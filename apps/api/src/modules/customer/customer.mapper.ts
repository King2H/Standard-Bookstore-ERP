import {
  Money,
  type Customer,
  type CustomerGroup,
  type LifecycleStatus,
} from '@bms/shared';
import { decryptPii } from '../../lib/piiEncryption.js';
import type {
  CustomerGroupRecord,
  CustomerGroupRef,
  CustomerRecord,
  LoyaltyHistoryRecord,
  StoreCreditHistoryRecord,
} from './customer.types.js';

/** The columns customer.repository selects for a customer. */
export interface CustomerRow {
  id: number;
  branch_id: number | null;
  customer_code: string;
  full_name: string;
  phone_encrypted: string | null;
  email_encrypted: string | null;
  gender: string | null;
  date_of_birth: Date | string | null;
  address: string | null;
  city: string | null;
  is_active: boolean;
  status: string;
  archived_at: Date | null;
  created_at: Date;
  points_balance: string;
  lifetime_points: string;
  store_credit_balance: string;
  outstanding_receivables: string;
}

function dateOnly(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().split('T')[0] : String(value);
}

export function toCustomerRecord(row: CustomerRow, groups: CustomerGroupRef[]): CustomerRecord {
  return {
    id: row.id,
    branchId: row.branch_id,
    customerCode: row.customer_code,
    fullName: row.full_name,
    phone: decryptPii(row.phone_encrypted),
    email: decryptPii(row.email_encrypted),
    gender: row.gender,
    dateOfBirth: dateOnly(row.date_of_birth),
    address: row.address,
    city: row.city,
    isActive: row.is_active,
    status: row.status as LifecycleStatus,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    loyaltyBalance: Number(row.points_balance),
    lifetimePoints: Number(row.lifetime_points),
    storeCreditBalance: Money.of(row.store_credit_balance),
    outstandingReceivables: Money.of(row.outstanding_receivables),
    groups,
  };
}

export function toCustomerResponse(record: CustomerRecord): Customer {
  return {
    ...record,
    archivedAt: record.archivedAt ? record.archivedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    storeCreditBalance: record.storeCreditBalance.toNumber(),
    outstandingReceivables: record.outstandingReceivables.toNumber(),
  };
}

export function toCustomerGroupResponse(record: CustomerGroupRecord): CustomerGroup {
  return { ...record };
}

export function toLoyaltyHistoryResponse(record: LoyaltyHistoryRecord) {
  return { ...record, createdAt: record.createdAt.toISOString() };
}

export function toStoreCreditHistoryResponse(record: StoreCreditHistoryRecord) {
  return { ...record, amount: record.amount.toNumber(), createdAt: record.createdAt.toISOString() };
}
