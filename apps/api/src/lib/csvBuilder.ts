import type { Response } from 'express';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CsvColumnDef {
  key: string;
  header: string;
  type: 'string' | 'number' | 'date' | 'integer';
}

// ── Column schemas ────────────────────────────────────────────────────────────

export const SALES_COLUMNS: CsvColumnDef[] = [
  { key: 'order_reference',    header: 'order_reference',    type: 'string'  },
  { key: 'date',               header: 'date',               type: 'date'    },
  { key: 'customer_name',      header: 'customer_name',      type: 'string'  },
  { key: 'sale_type',          header: 'sale_type',          type: 'string'  },
  { key: 'fulfillment_status', header: 'fulfillment_status', type: 'string'  },
  { key: 'subtotal',           header: 'subtotal',           type: 'number'  },
  { key: 'discount_normal',    header: 'discount_normal',    type: 'number'  },
  { key: 'discount_merchant',  header: 'discount_merchant',  type: 'number'  },
  { key: 'discount_special',   header: 'discount_special',   type: 'number'  },
  { key: 'total_discount',     header: 'total_discount',     type: 'number'  },
  { key: 'purchase_cost',      header: 'purchase_cost',      type: 'number'  },
  { key: 'net_profit',         header: 'net_profit',         type: 'number'  },
  { key: 'payment_status',     header: 'payment_status',     type: 'string'  },
  { key: 'collected_amount',   header: 'collected_amount',   type: 'number'  },
  { key: 'outstanding_amount', header: 'outstanding_amount', type: 'number'  },
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

function escapeCell(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n') || v.includes('\r')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/**
 * Builds a CSV string from rows and a column schema.
 * Does NOT add BOM — sendCsv handles that.
 */
export function buildCsv(
  rows: Record<string, unknown>[],
  columns: CsvColumnDef[],
): string {
  const headerLine = columns.map(c => escapeCell(c.header)).join(',');
  const dataLines = rows.map(row =>
    columns.map(c => escapeCell(formatValue(row[c.key], c.type))).join(','),
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
