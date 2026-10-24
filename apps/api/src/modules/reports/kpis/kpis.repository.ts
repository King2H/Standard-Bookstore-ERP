import type { Queryable } from '../../../db/tx.js';
import { reportRows } from '../../../db/reportDb.js';
import { NOT_SALE_ORDER_STATUS_LIST } from '../sales/sales.policy.js';

// The dashboard's KPI figures (#22). "Today" and "this month" are the
// database's calendar (CURRENT_DATE), never a JS Date, so the boundary is
// the same as every other date the system writes.

/** Confirmed orders not yet fulfilled: committed stock still to hand over. */
const OPEN_ORDER_STATUSES = `('Confirmed','In_Progress','CONFIRMED','PAID')`;

const today = (column: string) => `DATE(${column}) = CURRENT_DATE`;
const thisMonth = (column: string) => `date_trunc('month', ${column}) = date_trunc('month', now())`;

async function value(q: Queryable, text: string, params: unknown[]): Promise<string> {
  const [row] = await reportRows<{ val: string | number }>(q, text, params);
  return String(row.val);
}

/** `AND alias.branch_id = $1` when a branch is given (it is then the only parameter). */
function branchFilter(branchId: number | undefined, alias?: string): { cond: string; params: unknown[] } {
  if (!branchId) return { cond: '', params: [] };
  return { cond: `AND ${alias ? `${alias}.` : ''}branch_id = $1`, params: [branchId] };
}

function orderSales(q: Queryable, branchId: number | undefined, when: string) {
  const b = branchFilter(branchId);
  return value(
    q,
    `SELECT COALESCE(SUM(total), 0)::NUMERIC AS val FROM orders
     WHERE ${when} AND status NOT IN ${NOT_SALE_ORDER_STATUS_LIST} ${b.cond}`,
    b.params,
  );
}

function posSales(q: Queryable, branchId: number | undefined, when: string) {
  const b = branchFilter(branchId);
  return value(
    q,
    `SELECT COALESCE(SUM(grand_total), 0)::NUMERIC AS val FROM transactions
     WHERE ${when} AND status = 'completed' ${b.cond}`,
    b.params,
  );
}

function exchangeSales(q: Queryable, branchId: number | undefined, when: string) {
  const b = branchFilter(branchId);
  return value(
    q,
    `SELECT COALESCE(SUM(total_outgoing_value), 0)::NUMERIC AS val FROM exchanges
     WHERE ${when} AND status IN ('Completed', 'COMPLETED') ${b.cond}`,
    b.params,
  );
}

export interface KpiFigures {
  dailyOrderSales: string; dailyPosSales: string; dailyExchangeSales: string;
  monthlyOrderSales: string; monthlyPosSales: string; monthlyExchangeSales: string;
  outstanding: string; overdue: string; averageOrderValue: string; inventoryValue: string;
  activeCustomers: number; lowStockAlerts: number; pendingOrders: number; exchangesToday: number;
}

export async function kpiFigures(q: Queryable, branchId: number | undefined): Promise<KpiFigures> {
  const b = branchFilter(branchId);
  const l = branchFilter(branchId, 'l');
  const count = async (text: string, params: unknown[]) => Number(await value(q, text, params));
  const [
    dailyOrderSales, dailyPosSales, dailyExchangeSales,
    monthlyOrderSales, monthlyPosSales, monthlyExchangeSales,
    outstanding, overdue, averageOrderValue, inventoryValue,
    activeCustomers, lowStockAlerts, pendingOrders, exchangesToday,
  ] = await Promise.all([
    orderSales(q, branchId, today('created_at')),
    posSales(q, branchId, today('created_at')),
    exchangeSales(q, branchId, today('created_at')),
    orderSales(q, branchId, thisMonth('created_at')),
    posSales(q, branchId, thisMonth('created_at')),
    exchangeSales(q, branchId, thisMonth('created_at')),
    value(q, `SELECT COALESCE(SUM(outstanding_amount), 0)::NUMERIC AS val FROM receivables WHERE status IN ('Pending', 'PartiallyPaid', 'Overdue') ${b.cond}`, b.params),
    // Overdue is kept up to date by the receivables' overdue job, not derived here.
    value(q, `SELECT COALESCE(SUM(outstanding_amount), 0)::NUMERIC AS val FROM receivables WHERE status = 'Overdue' ${b.cond}`, b.params),
    value(q, `SELECT COALESCE(AVG(total), 0)::NUMERIC AS val FROM orders WHERE status NOT IN ${NOT_SALE_ORDER_STATUS_LIST} ${b.cond}`, b.params),
    // Quantity × average cost now, not a period flow.
    value(q, `SELECT COALESCE(SUM(i.inventory_value), 0)::NUMERIC AS val FROM inventory i JOIN locations l ON l.id = i.location_id WHERE true ${l.cond}`, l.params),
    count(`SELECT COUNT(*)::INTEGER AS val FROM customers WHERE is_active = true ${b.cond}`, b.params),
    count(`SELECT COUNT(*)::INTEGER AS val FROM inventory i JOIN locations l ON l.id = i.location_id WHERE i.quantity <= i.reorder_point ${l.cond}`, l.params),
    count(`SELECT COUNT(*)::INTEGER AS val FROM orders WHERE status IN ${OPEN_ORDER_STATUSES} ${b.cond}`, b.params),
    count(`SELECT COUNT(*)::INTEGER AS val FROM exchanges WHERE DATE(created_at) = CURRENT_DATE ${b.cond}`, b.params),
  ]);
  return {
    dailyOrderSales, dailyPosSales, dailyExchangeSales,
    monthlyOrderSales, monthlyPosSales, monthlyExchangeSales,
    outstanding, overdue, averageOrderValue, inventoryValue,
    activeCustomers, lowStockAlerts, pendingOrders, exchangesToday,
  };
}

/** Today, the start of this week, month and year, and the previous equivalent periods, as YYYY-MM-DD. */
export async function calendar(q: Queryable): Promise<Record<string, string>> {
  const [row] = await reportRows<Record<string, string>>(
    q,
    `SELECT
       TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today,
       TO_CHAR(date_trunc('week', CURRENT_DATE), 'YYYY-MM-DD') AS week_start,
       TO_CHAR(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD') AS month_start,
       TO_CHAR(date_trunc('year', CURRENT_DATE), 'YYYY-MM-DD') AS year_start,
       TO_CHAR(CURRENT_DATE - INTERVAL '1 day', 'YYYY-MM-DD') AS yesterday,
       TO_CHAR(date_trunc('week', CURRENT_DATE) - INTERVAL '1 week', 'YYYY-MM-DD') AS prev_week_start,
       TO_CHAR(date_trunc('week', CURRENT_DATE) - INTERVAL '1 day', 'YYYY-MM-DD') AS prev_week_end,
       TO_CHAR(date_trunc('month', CURRENT_DATE) - INTERVAL '1 month', 'YYYY-MM-DD') AS prev_month_start,
       TO_CHAR(date_trunc('month', CURRENT_DATE) - INTERVAL '1 day', 'YYYY-MM-DD') AS prev_month_end,
       TO_CHAR(date_trunc('year', CURRENT_DATE) - INTERVAL '1 year', 'YYYY-MM-DD') AS prev_year_start,
       TO_CHAR(date_trunc('year', CURRENT_DATE) - INTERVAL '1 day', 'YYYY-MM-DD') AS prev_year_end`,
  );
  return row;
}
