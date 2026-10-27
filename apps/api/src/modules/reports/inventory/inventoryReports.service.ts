import { Money, type InventoryReport } from '@bms/shared';
import { reportDb } from '../../../db/reportDb.js';
import type { ReportFilters } from '../reportScope.js';
import * as stock from './inventoryReports.repository.js';

/** Stock report use cases (#22), read on the report connection. */

const num = (v: unknown): number => (v == null ? 0 : Money.of(v as string).toNumber());
/** Unit costs keep the 4 decimals they are stored with. */
const cost = (v: unknown): number => (v == null ? 0 : Money.of(v as string).toNumber(4));

/** One row per book and location, as the inventory and valuation exports list it. */
export interface StockExportRow {
  book_code: string;
  isbn: string;
  title: string;
  author: string;
  category: string;
  publisher: string;
  /** The location, or the transfer note the copies are on their way on (#170). */
  location: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
  unit_cost: number;
  last_movement_date: string;
  average_cost: number;
  inventory_value: number;
  last_purchase_cost: number;
  last_selling_price: number;
}

export async function getInventoryReport(filters: ReportFilters): Promise<InventoryReport> {
  const [s, low, top, movement] = await Promise.all([
    stock.stockSummary(reportDb, filters.branchId),
    stock.lowStock(reportDb, filters.branchId),
    stock.topSelling(reportDb, filters),
    stock.stockMovement(reportDb, filters),
  ]);
  return {
    summary: {
      totalBooks: s.total_books,
      totalStockUnits: s.total_units,
      availableStock: s.available_stock,
      reservedStock: s.reserved_stock,
      lowStockItems: s.low_stock,
      outOfStockItems: s.out_of_stock,
    },
    lowStockItems: low.map((r) => ({
      bookId: r.book_id,
      title: r.title,
      locationId: r.location_id,
      locationName: r.location_name,
      quantity: r.quantity,
      reorderPoint: r.reorder_point,
    })),
    topSellingBooks: top.map((r) => ({ bookId: r.book_id, title: r.title, unitsSold: r.units_sold, revenue: num(r.revenue) })),
    stockMovement: movement.map((r) => ({ period: r.period, stockIn: r.stock_in, stockOut: r.stock_out })),
  };
}

export async function getStockExportRows(branchId: number | undefined): Promise<StockExportRow[]> {
  const rows = await stock.stockRows(reportDb, branchId);
  return rows.map((row) => ({
    book_code: (row.book_code as string | null) ?? '',
    isbn: (row.isbn as string | null) ?? '',
    title: row.title as string,
    author: (row.author as string | null) ?? '',
    category: (row.category as string | null) ?? '',
    publisher: (row.publisher as string | null) ?? '',
    location: row.location_name as string,
    quantity_on_hand: row.quantity_on_hand as number,
    quantity_reserved: row.quantity_reserved as number,
    quantity_available: row.quantity_available as number,
    unit_cost: cost(row.unit_cost),
    last_movement_date: (row.last_movement_date_str as string | null) ?? '',
    // unit_cost is already the location's average cost; the valuation export
    // lists it again under its own name.
    average_cost: cost(row.unit_cost),
    inventory_value: num(row.inventory_value),
    last_purchase_cost: cost(row.last_purchase_cost),
    last_selling_price: num(row.last_selling_price),
  }));
}

/**
 * The valuation export: stock on hand by location, then what is on its way
 * between branches at the cost it left at, valued apart from either branch
 * (#170, decision 3a).
 */
export async function getValuationRows(branchId: number | undefined): Promise<StockExportRow[]> {
  const [onHand, inTransit] = await Promise.all([getStockExportRows(branchId), stock.inTransitRows(reportDb, branchId)]);
  return [
    ...onHand,
    ...inTransit.map((row) => {
      const quantity = Number(row.quantity);
      const unitCost = Money.of(row.unit_cost as string);
      return {
        book_code: (row.book_code as string | null) ?? '',
        isbn: (row.isbn as string | null) ?? '',
        title: row.title as string,
        author: '',
        category: '',
        publisher: '',
        location: `In transit ${row.transfer_number as string}: ${row.from_branch as string} to ${row.to_branch as string}`,
        quantity_on_hand: quantity,
        quantity_reserved: 0,
        quantity_available: 0,
        unit_cost: unitCost.toNumber(4),
        last_movement_date: (row.dispatched_on as string | null) ?? '',
        average_cost: unitCost.toNumber(4),
        inventory_value: unitCost.times(quantity).round(2).toNumber(),
        last_purchase_cost: 0,
        last_selling_price: 0,
      };
    }),
  ];
}

