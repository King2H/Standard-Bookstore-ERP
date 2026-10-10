import type { Money } from '@bms/shared';

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}

export type SettlementType = 'Even' | 'Customer_Pays' | 'Store_Refunds';
export type RefundMethod = 'store_credit' | 'cash';
export type Condition = 'resellable' | 'damaged';
export type PaymentMethod = 'cash' | 'bank' | 'mobile' | 'store_credit' | 'loyalty_points';

export interface ExchangeRecord {
  id: string;
  exchangeReference: string;
  branchId: number;
  locationId: number | null;
  customerId: number | null;
  status: string;
  lifecycleStatus: string | null;
  totalIncomingValue: Money;
  totalOutgoingValue: Money;
  netBalance: Money;
  settlementType: SettlementType;
  refundMethod: RefundMethod | null;
  currency: string;
  notes: string | null;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
  /** The receivable of the credit left, if any. */
  receivableOutstanding: Money | null;
  receivableStatus: string | null;
  dueDate: string | null;
  /** YYYY-MM-DD in the database's calendar. */
  madeOn: string;
  today: string;
  voidedAt: Date | null;
  voidedBy: number | null;
  voidReason: string | null;
  incomingItems?: ExchangeItemRecord[];
  outgoingItems?: ExchangeItemRecord[];
  settlementEntries?: SettlementEntryRecord[];
}

export interface ExchangeItemRecord {
  id: string;
  exchangeId: string;
  bookId: number;
  bookTitle: string;
  quantity: number;
  unitPrice: Money;
  totalPrice: Money;
  condition?: Condition;
  /** Outgoing: the average cost the books left stock at. */
  unitCost?: Money | null;
}

export interface SettlementEntryRecord {
  id: string;
  entryType: string;
  amount: Money;
  method: string | null;
  createdAt: Date;
}

export interface PaymentLine {
  method: PaymentMethod;
  amount: Money;
  reference: string | null;
}

export interface NewExchange {
  branchId: number;
  locationId: number;
  customerId: number | null;
  notes: string | null;
  incoming: Array<{ bookId: number; quantity: number; unitValue: Money; condition: Condition }>;
  outgoing: Array<{ bookId: number; quantity: number }>;
  payments: PaymentLine[];
  allowCredit: boolean;
  dueDate: string | null;
  refundMethod: RefundMethod;
}

export interface ExchangeFilter {
  /** The scoped branch: exchanges are branch-owned (#12). */
  branchId: number;
  customerId?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

export type Paging = { page: number; pageSize: number };
