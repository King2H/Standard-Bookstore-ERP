import type { Response } from 'express';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CsvColumnDef {
  key: string;
  header: string;
  type: 'string' | 'number' | 'date' | 'integer';
}

// ── Column schemas ────────────────────────────────────────────────────────────

// Dashboard Standardization & Unified Reports Engine — one row per line item
// across all four revenue-moving channels (ORDER/POS/RETURN/EXCHANGE); see
// financialReport.service.ts for how each channel maps onto this shape.
// transaction_date is sourced as an already-local YYYY-MM-DD string (SQL
// TO_CHAR(..., 'YYYY-MM-DD'), never a JS Date/toISOString() round-trip) —
// kept as 'string' here so formatValue() doesn't re-parse it through Date().
// Legacy 14-column schema — no longer wired to any route as of Prompt 2
// (see SALES_COLUMNS below, which replaces it per that ticket's explicit
// Sales Report field list). Kept only in case another caller still expects
// this exact shape.
export const LEGACY_SALES_COLUMNS: CsvColumnDef[] = [
  { key: 'transaction_date',   header: 'transaction_date',   type: 'string'  },
  { key: 'transaction_type',   header: 'transaction_type',   type: 'string'  },
  { key: 'reference_number',   header: 'reference_number',   type: 'string'  },
  { key: 'branch',             header: 'branch',             type: 'string'  },
  { key: 'customer_name',      header: 'customer_name',      type: 'string'  },
  { key: 'book_title',         header: 'book_title',         type: 'string'  },
  { key: 'book_isbn',          header: 'book_isbn',          type: 'string'  },
  { key: 'quantity',           header: 'quantity',           type: 'integer' },
  { key: 'unit_price',         header: 'unit_price',         type: 'number'  },
  { key: 'discount_amount',    header: 'discount_amount',    type: 'number'  },
  { key: 'gross_amount',       header: 'gross_amount',       type: 'number'  },
  { key: 'net_amount',         header: 'net_amount',         type: 'number'  },
  { key: 'payment_status',     header: 'payment_status',     type: 'string'  },
  { key: 'payment_method',     header: 'payment_method',     type: 'string'  },
];

// Prompt 2 Sales Report field list — one row per line item, sourced from
// getSalesReportRows() (reports.service.ts), which wraps
// financialReport.service.ts's unified engine.
export const SALES_COLUMNS: CsvColumnDef[] = [
  { key: 'date',                header: 'Date',                type: 'string'  },
  { key: 'invoice_no',          header: 'Invoice No',          type: 'string'  },
  { key: 'source',              header: 'Source',              type: 'string'  },
  { key: 'customer',            header: 'Customer',            type: 'string'  },
  { key: 'book',                header: 'Book',                type: 'string'  },
  { key: 'qty',                 header: 'Qty',                 type: 'integer' },
  { key: 'unit_price',          header: 'Unit Price',          type: 'number'  },
  { key: 'discount',            header: 'Discount',            type: 'number'  },
  { key: 'gross_amount',        header: 'Gross Amount',        type: 'number'  },
  { key: 'return_amount',       header: 'Return Amount',       type: 'number'  },
  { key: 'net_sales_amount',    header: 'Net Sales Amount',    type: 'number'  },
  { key: 'cost_amount',         header: 'Cost Amount',         type: 'number'  },
  { key: 'gross_profit',        header: 'Gross Profit',        type: 'number'  },
  { key: 'payment_status',      header: 'Payment Status',      type: 'string'  },
  { key: 'cash_collected',      header: 'Cash Collected',      type: 'number'  },
  { key: 'receivable_balance',  header: 'Receivable Balance',  type: 'number'  },
  { key: 'branch',              header: 'Branch',              type: 'string'  },
  { key: 'location',            header: 'Location',            type: 'string'  },
  { key: 'user',                header: 'User',                type: 'string'  },
];

export const RETURN_COLUMNS: CsvColumnDef[] = [
  { key: 'return_no',            header: 'Return No',            type: 'string'  },
  { key: 'original_invoice_no',  header: 'Original Invoice No',  type: 'string'  },
  { key: 'customer',             header: 'Customer',             type: 'string'  },
  { key: 'book',                 header: 'Book',                 type: 'string'  },
  { key: 'qty_returned',         header: 'Qty Returned',         type: 'integer' },
  { key: 'refund_amount',        header: 'Refund Amount',        type: 'number'  },
  { key: 'original_cost',        header: 'Original Cost',        type: 'number'  },
  { key: 'profit_reversed',      header: 'Profit Reversed',      type: 'number'  },
  { key: 'refund_method',        header: 'Refund Method',        type: 'string'  },
  { key: 'return_date',          header: 'Return Date',          type: 'string'  },
  { key: 'user',                 header: 'User',                 type: 'string'  },
];

export const EXCHANGE_DETAIL_COLUMNS: CsvColumnDef[] = [
  { key: 'exchange_no',                header: 'Exchange No',                type: 'string' },
  { key: 'customer',                   header: 'Customer',                   type: 'string' },
  { key: 'incoming_book',              header: 'Incoming Book',              type: 'string' },
  { key: 'incoming_value',             header: 'Incoming Value',             type: 'number' },
  { key: 'outgoing_book',              header: 'Outgoing Book',              type: 'string' },
  { key: 'outgoing_value',             header: 'Outgoing Value',             type: 'number' },
  { key: 'difference',                 header: 'Difference',                 type: 'number' },
  { key: 'difference_payment_status',  header: 'Difference Payment Status',  type: 'string' },
  { key: 'cash_collected',             header: 'Cash Collected',             type: 'number' },
  { key: 'receivable_balance',         header: 'Receivable Balance',         type: 'number' },
  { key: 'date',                       header: 'Date',                       type: 'string' },
  { key: 'user',                       header: 'User',                       type: 'string' },
];

export const PAYMENTS_LEDGER_COLUMNS: CsvColumnDef[] = [
  { key: 'receipt_no',       header: 'Receipt No',       type: 'string' },
  { key: 'party',            header: 'Party',            type: 'string' },
  { key: 'reference_type',   header: 'Reference Type',   type: 'string' },
  { key: 'reference_no',     header: 'Reference No',     type: 'string' },
  { key: 'payment_method',   header: 'Payment Method',   type: 'string' },
  { key: 'amount',           header: 'Amount',           type: 'number' },
  { key: 'direction',        header: 'Direction',        type: 'string' },
  { key: 'date',             header: 'Date',             type: 'string' },
  { key: 'user',             header: 'User',             type: 'string' },
];

export const RECEIVABLES_AGING_COLUMNS: CsvColumnDef[] = [
  { key: 'customer',            header: 'Customer',            type: 'string' },
  { key: 'invoice_no',          header: 'Invoice No',          type: 'string' },
  { key: 'invoice_date',        header: 'Invoice Date',        type: 'string' },
  { key: 'due_date',            header: 'Due Date',            type: 'string' },
  { key: 'outstanding_amount',  header: 'Outstanding Amount',  type: 'number' },
  { key: 'aging_bucket',        header: 'Aging Bucket',        type: 'string' },
  { key: 'last_payment_date',   header: 'Last Payment Date',   type: 'string' },
];

// Inventory Valuation Report (Prompt 2) — Book/ISBN/Qty On Hand/Average
// Cost/Inventory Value/Last Movement Date/Last Purchase Cost/Last Selling
// Price. The general-purpose inventory export (with author/category/
// publisher/reserved/available) stays available as INVENTORY_COLUMNS below
// for the existing Inventory page export button.
export const INVENTORY_VALUATION_COLUMNS: CsvColumnDef[] = [
  { key: 'title',               header: 'Book',                type: 'string'  },
  { key: 'isbn',                header: 'ISBN',                 type: 'string'  },
  { key: 'quantity_on_hand',    header: 'Qty On Hand',          type: 'integer' },
  { key: 'average_cost',        header: 'Average Cost',         type: 'number'  },
  { key: 'inventory_value',     header: 'Inventory Value',      type: 'number'  },
  { key: 'last_movement_date',  header: 'Last Movement Date',   type: 'date'    },
  { key: 'last_purchase_cost',  header: 'Last Purchase Cost',   type: 'number'  },
  { key: 'last_selling_price',  header: 'Last Selling Price',   type: 'number'  },
];

export const INVENTORY_COLUMNS: CsvColumnDef[] = [
  { key: 'book_code',          header: 'book_code',          type: 'string'  },
  { key: 'isbn',               header: 'isbn',               type: 'string'  },
  { key: 'title',              header: 'title',              type: 'string'  },
  { key: 'author',             header: 'author',             type: 'string'  },
  { key: 'category',           header: 'category',           type: 'string'  },
  { key: 'publisher',          header: 'publisher',          type: 'string'  },
  { key: 'quantity_on_hand',   header: 'quantity_on_hand',   type: 'integer' },
  { key: 'quantity_reserved',  header: 'quantity_reserved',  type: 'integer' },
  { key: 'quantity_available', header: 'quantity_available', type: 'integer' },
  { key: 'unit_cost',          header: 'unit_cost',          type: 'number'  },
  { key: 'last_movement_date', header: 'last_movement_date', type: 'date'    },
];

export const PROCUREMENT_COLUMNS: CsvColumnDef[] = [
  { key: 'po_reference',       header: 'po_reference',       type: 'string'  },
  { key: 'date',               header: 'date',               type: 'date'    },
  { key: 'supplier_name',      header: 'supplier_name',      type: 'string'  },
  { key: 'status',             header: 'status',             type: 'string'  },
  { key: 'book_code',          header: 'book_code',          type: 'string'  },
  { key: 'title',              header: 'title',              type: 'string'  },
  { key: 'ordered_quantity',   header: 'ordered_quantity',   type: 'integer' },
  { key: 'received_quantity',  header: 'received_quantity',  type: 'integer' },
  { key: 'unit_cost',          header: 'unit_cost',          type: 'number'  },
  { key: 'line_total',         header: 'line_total',         type: 'number'  },
  { key: 'po_total',           header: 'po_total',           type: 'number'  },
];

export const RECEIVABLES_COLUMNS: CsvColumnDef[] = [
  { key: 'order_reference',    header: 'order_reference',    type: 'string'  },
  { key: 'date',               header: 'date',               type: 'date'    },
  { key: 'customer_name',      header: 'customer_name',      type: 'string'  },
  { key: 'original_amount',    header: 'original_amount',    type: 'number'  },
  { key: 'collected_amount',   header: 'collected_amount',   type: 'number'  },
  { key: 'outstanding_amount', header: 'outstanding_amount', type: 'number'  },
  { key: 'due_date',           header: 'due_date',           type: 'date'    },
  { key: 'days_overdue',       header: 'days_overdue',       type: 'integer' },
  { key: 'payment_status',     header: 'payment_status',     type: 'string'  },
];

// ── Procurement reports (Prompt 2) ──────────────────────────────────────────

export const OPEN_POS_COLUMNS: CsvColumnDef[] = [
  { key: 'po_reference',       header: 'PO Reference',       type: 'string' },
  { key: 'supplier',           header: 'Supplier',           type: 'string' },
  { key: 'order_date',         header: 'Order Date',         type: 'string' },
  { key: 'expected_date',      header: 'Expected Date',      type: 'string' },
  { key: 'ordered_qty',        header: 'Ordered Qty',        type: 'integer' },
  { key: 'received_qty',       header: 'Received Qty',       type: 'integer' },
  { key: 'total_amount',       header: 'Total Amount',       type: 'number' },
  { key: 'outstanding_amount', header: 'Outstanding Amount', type: 'number' },
  { key: 'receipt_status',     header: 'Receipt Status',     type: 'string' },
  { key: 'payment_status',     header: 'Payment Status',     type: 'string' },
];

export const SUPPLIER_BALANCES_COLUMNS: CsvColumnDef[] = [
  { key: 'supplier',            header: 'Supplier',            type: 'string' },
  { key: 'open_po_count',       header: 'Open POs',            type: 'integer' },
  { key: 'received_value',      header: 'Received Value',      type: 'number' },
  { key: 'paid',                header: 'Paid',                type: 'number' },
  { key: 'credited',            header: 'Credited',            type: 'number' },
  { key: 'outstanding_balance', header: 'Outstanding Balance', type: 'number' },
];

export const AP_AGING_COLUMNS: CsvColumnDef[] = [
  { key: 'supplier',            header: 'Supplier',            type: 'string' },
  { key: 'po_reference',        header: 'PO Reference',        type: 'string' },
  { key: 'outstanding_amount',  header: 'Outstanding Amount',  type: 'number' },
  { key: 'aging_bucket',        header: 'Aging Bucket',        type: 'string' },
  { key: 'last_receipt_date',   header: 'Last Receipt Date',   type: 'string' },
];

export const PURCHASES_BY_SUPPLIER_COLUMNS: CsvColumnDef[] = [
  { key: 'supplier',        header: 'Supplier',        type: 'string' },
  { key: 'po_count',        header: 'PO Count',        type: 'integer' },
  { key: 'ordered_value',   header: 'Ordered Value',   type: 'number' },
  { key: 'received_value',  header: 'Received Value',  type: 'number' },
];

export const PURCHASES_BY_BOOK_COLUMNS: CsvColumnDef[] = [
  { key: 'title',         header: 'Book',          type: 'string'  },
  { key: 'isbn',          header: 'ISBN',          type: 'string'  },
  { key: 'ordered_qty',   header: 'Ordered Qty',   type: 'integer' },
  { key: 'received_qty',  header: 'Received Qty',  type: 'integer' },
  { key: 'total_value',   header: 'Total Value',   type: 'number'  },
];

export const SUPPLIER_PAYMENT_HISTORY_COLUMNS: CsvColumnDef[] = [
  { key: 'date',            header: 'Date',            type: 'string' },
  { key: 'supplier',        header: 'Supplier',        type: 'string' },
  { key: 'po_reference',    header: 'PO Reference',    type: 'string' },
  { key: 'amount',          header: 'Amount',          type: 'number' },
  { key: 'payment_method',  header: 'Payment Method',  type: 'string' },
  { key: 'source',          header: 'Source',          type: 'string' },
  { key: 'user',            header: 'User',            type: 'string' },
];

export const SUPPLIER_LEDGER_COLUMNS: CsvColumnDef[] = [
  { key: 'date',         header: 'Date',         type: 'string' },
  { key: 'type',         header: 'Type',         type: 'string' },
  { key: 'reference',    header: 'Reference',    type: 'string' },
  { key: 'description',  header: 'Description',  type: 'string' },
  { key: 'amount',       header: 'Amount',       type: 'number' },
  { key: 'balance',      header: 'Balance',      type: 'number' },
];

// ── Core builder ──────────────────────────────────────────────────────────────

function formatValue(v: unknown, type: CsvColumnDef['type']): string {
  if (v == null) return '';
  if (type === 'number') {
    const n = parseFloat(String(v));
    return isNaN(n) ? '' : n.toFixed(2);
  }
  if (type === 'integer') {
    const n = Number(v);
    return isNaN(n) ? '' : Math.round(n).toString();
  }
  if (type === 'date') {
    try {
      const d = v instanceof Date ? v : new Date(String(v));
      if (isNaN(d.getTime())) return '';
      return d.toISOString().slice(0, 10);
    } catch {
      return '';
    }
  }
  return String(v);
}

// Module 7: guard against CSV/formula injection on free-text cells. A string
// value beginning with =, +, -, or @ is interpreted by Excel/Sheets as a
// formula when the file is opened — e.g. a customer or supplier name of
// "=1+1" or "=HYPERLINK(...)" entered via a form field would silently
// become a live formula for whoever opens the export. Prefixing with a
// single quote neutralizes it (OWASP's standard CSV-injection mitigation)
// while leaving the visible value unchanged in every spreadsheet app.
// Deliberately scoped to 'string' columns only — number/integer columns can
// legitimately start with '-' (a negative amount) and must never be
// quote-prefixed, or the exported figure itself would be corrupted.
const FORMULA_TRIGGER_CHARS = ['=', '+', '-', '@'];

function escapeCell(v: string, isFreeText: boolean): string {
  let cell = v;
  if (isFreeText && cell.length > 0 && FORMULA_TRIGGER_CHARS.includes(cell[0])) {
    cell = `'${cell}`;
  }
  if (cell.includes(',') || cell.includes('"') || cell.includes('\n') || cell.includes('\r')) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

/**
 * Builds a CSV string from rows and a column schema.
 * Does NOT add BOM — sendCsv handles that.
 */
export function buildCsv(
  rows: Record<string, unknown>[],
  columns: CsvColumnDef[],
): string {
  // Headers are static column names from CsvColumnDef, not user input — no
  // formula-trigger check needed there, only the RFC4180 quoting.
  const headerLine = columns.map(c => escapeCell(c.header, false)).join(',');
  const dataLines = rows.map(row =>
    columns.map(c => escapeCell(formatValue(row[c.key], c.type), c.type === 'string')).join(','),
  );
  return [headerLine, ...dataLines].join('\r\n');
}

/**
 * Sends a CSV file response with UTF-8 BOM for Excel compatibility.
 */
export function sendCsv(res: Response, filename: string, csvContent: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csvContent); // UTF-8 BOM
}
