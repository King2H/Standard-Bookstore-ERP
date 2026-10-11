import { Money, type CustomerReport } from '@bms/shared';
import { reportDb } from '../../../db/reportDb.js';
import type { ReportFilters } from '../reportScope.js';
import * as customers from './customerReports.repository.js';

/** Customer report use cases (#22), read on the report connection. */

export async function getCustomerReport(filters: ReportFilters): Promise<CustomerReport> {
  const [totals, repeat, fresh, top] = await Promise.all([
    customers.customerTotals(reportDb, filters.branchId),
    customers.repeatCustomers(reportDb, filters),
    customers.newCustomers(reportDb, filters),
    customers.topCustomers(reportDb, filters),
  ]);
  return {
    summary: {
      totalCustomers: totals.total_customers,
      activeCustomers: totals.active_customers,
      repeatCustomers: repeat,
      newCustomersInPeriod: fresh.total,
    },
    topCustomers: top.map((r) => ({
      customerId: r.customer_id,
      fullName: r.full_name,
      totalSpend: Money.of(r.total_spend).toNumber(),
      orderCount: r.order_count,
    })),
    byPeriod: fresh.byPeriod.map((r) => ({ period: r.period, newCustomers: r.new_customers })),
  };
}
