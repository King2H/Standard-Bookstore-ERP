import type { KpiPeriod } from '@bms/shared';
import type { ReportParams } from '../api.js';
import { AgingSummary, ExchangeActivity, PaymentMethods, PaymentTrend, TopReturnedBooks } from './MoneySections.js';
import { BranchSales, DiscountSummary, GrossProfitTrendSection, SalesTrend } from './SalesSections.js';
import { CustomerInsights, InventoryInsights, StockMovement } from './StockCustomerSections.js';

/** The report sections under the Live Overview, read with the Dashboard's filters. */
export function ReportSections({ params, salesPeriod, onNavigate }: {
  params: ReportParams;
  /** The Live Overview's period, which Payment Methods follows (#230, K7). */
  salesPeriod: KpiPeriod;
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2"><SalesTrend params={params} /></div>
        <PaymentMethods params={params} period={salesPeriod} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <BranchSales params={params} />
        <ExchangeActivity params={params} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2"><GrossProfitTrendSection params={params} /></div>
        <TopReturnedBooks params={params} />
      </div>

      <AgingSummary branchId={params.branchId} onNavigate={onNavigate} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <InventoryInsights params={params} />
        <CustomerInsights params={params} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StockMovement params={params} />
        <PaymentTrend params={params} />
      </div>

      <DiscountSummary params={params} />
    </>
  );
}
