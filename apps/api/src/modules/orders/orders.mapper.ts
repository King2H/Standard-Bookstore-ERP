import type { OrderLineItemRow, OrderRow, SaleType } from './orders.types.js';

/** The orders columns the repository selects, plus the two derived fields. */
export interface OrderDbRow {
  id: string;
  order_number: string;
  customer_id: number | null;
  branch_id: number;
  location_id: number | null;
  channel: string;
  status: string;
  payment_status: string;
  sale_type: string;
  currency: string;
  subtotal: string;
  discount_amount: string;
  discount_total: string;
  tax_rate: string;
  tax_amount: string;
  total: string;
  cancel_reason: string | null;
  notes: string | null;
  created_by: number;
  created_at: Date;
  updated_at: Date;
  payment_method?: string | null;
  due_date?: string | null;
}

export interface LineItemDbRow {
  id: string;
  order_id: string;
  book_id: number;
  book_title: string | null;
  book_isbn: string | null;
  quantity: number;
  unit_price: string;
  discount_amount: string;
  total_price: string;
  qty_reserved: number;
  qty_fulfilled: number;
  is_backordered: boolean;
  unit_cost: string | null;
}

// Numeric columns arrive as exact decimal strings; the API returns them as
// numbers. Arithmetic on them goes through Money (orders.policy.ts).
export function toOrderRow(row: OrderDbRow): OrderRow {
  return {
    id: String(row.id), orderNumber: row.order_number,
    customerId: row.customer_id, branchId: row.branch_id,
    locationId: row.location_id, channel: row.channel,
    status: row.status, paymentStatus: row.payment_status,
    saleType: (row.sale_type ?? 'cash_sale') as SaleType,
    currency: row.currency, subtotal: Number(row.subtotal),
    discountAmount: Number(row.discount_amount),
    discountTotal: Number(row.discount_total ?? '0'),
    taxRate: Number(row.tax_rate),
    taxAmount: Number(row.tax_amount), total: Number(row.total),
    cancelReason: row.cancel_reason, notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    paymentMethod: row.payment_method ?? null,
    dueDate: row.due_date ?? null,
  };
}

export function toLineItemRow(row: LineItemDbRow): OrderLineItemRow {
  return {
    id: String(row.id), orderId: String(row.order_id), bookId: row.book_id,
    bookTitle: row.book_title ?? '', bookIsbn: row.book_isbn ?? '',
    quantity: row.quantity, unitPrice: Number(row.unit_price),
    discountAmount: Number(row.discount_amount), totalPrice: Number(row.total_price),
    qtyReserved: row.qty_reserved, qtyFulfilled: row.qty_fulfilled,
    isBackordered: row.is_backordered,
    unitCost: row.unit_cost != null ? Number(row.unit_cost) : null,
  };
}
