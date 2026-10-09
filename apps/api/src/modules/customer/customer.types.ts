import type { LifecycleStatus, Money } from '@bms/shared';

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}

export interface CustomerGroupRef {
  id: number;
  name: string;
  discountPct: number;
}

/** A customers row in application form, with its balances and groups. */
export interface CustomerRecord {
  id: number;
  branchId: number | null;
  customerCode: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  address: string | null;
  city: string | null;
  isActive: boolean;
  status: LifecycleStatus;
  archivedAt: Date | null;
  createdAt: Date;
  loyaltyBalance: number;
  lifetimePoints: number;
  storeCreditBalance: Money;
  outstandingReceivables: Money;
  groups: CustomerGroupRef[];
}

export interface CustomerFilter {
  q?: string;
  branchId?: number;
  isActive?: boolean;
  /** Undefined means any status. */
  statuses?: LifecycleStatus[];
  groupId?: number;
}

/** A phone or email as stored: encrypted, with a lookup hash for exact search (#90). */
export interface StoredContact {
  encrypted: string | null;
  lookup: string | null;
}

export interface NewCustomer {
  branchId: number | null;
  customerCode: string;
  fullName: string;
  phone: StoredContact;
  email: StoredContact;
  gender: string | null;
  dateOfBirth: string | null;
  address: string | null;
  city: string | null;
  createdBy: number;
}

export interface CustomerChanges {
  fullName?: string;
  phone?: StoredContact;
  email?: StoredContact;
  gender?: string | null;
  dateOfBirth?: string | null;
  address?: string | null;
  city?: string | null;
  branchId?: number | null;
  updatedBy: number;
}

export interface CustomerGroupRecord {
  id: number;
  name: string;
  description: string | null;
  discountPct: number;
}

export interface LoyaltyHistoryRecord {
  id: string;
  customerId: number;
  transactionRef: string | null;
  pointsDelta: number;
  reason: string;
  createdAt: Date;
}

export interface StoreCreditHistoryRecord {
  id: string;
  customerId: number;
  refType: string | null;
  refId: string | null;
  amount: Money;
  direction: 'credit' | 'debit';
  createdAt: Date;
}
