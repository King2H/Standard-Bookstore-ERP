import { db } from '../db/index.js';
import { costBasisLateralJoin } from './costBasis.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NetProfitResult {
  netProfit: number;
  fulfilledRevenue: number;   // orders (FULFILLED/COMPLETED) + POS grand_total
  purchaseCost: number;
  totalDiscounts: number;     // order discount_total + POS discount_total
  returnsValue: number;
  returnsCost: number;        // COGS credited back for returned units (Return Posting Rule)
  exchangeAdjustment: number;
  cashSalesRevenue: number;
  creditSalesRevenue: number;
  collectedCreditRevenue: number;
  outstandingReceivables: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildOrderFilters(opts: {
  branchId?: number;
  dateFrom?: string;
  dateTo?: string;
}): { conditions: string[]; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (opts.branchId !== undefined) {
    params.push(opts.branchId);
    conditions.push(`o.branch_id = $${params.length}`);
  }
  if (opts.dateFrom) {
    params.push(opts.dateFrom);
    conditions.push(`o.created_at::date >= $${params.length}::date`);
  }
  if (opts.dateTo) {
    params.push(opts.dateTo);
    conditions.push(`o.created_at::date <= $${params.length}::date`);
  }
  return { conditions, params };
}

// ── Single source of truth for net profit ────────────────────────────────────

/**
 * Computes the net profit breakdown for a given date range and/or branch.
 *
 * Covers ALL sales channels:
 *   - Orders (FULFILLED/COMPLETED) from the `orders` table
 *   - POS transactions (completed) from the `transactions` table
 *
 * All 8 sub-queries run in parallel via Promise.all.
 *
 * Formula:
 *   netProfit = (orderRevenue + posRevenue)
 *             - purchaseCost
 *             - returnsValue
 *             + returnsCost
 *             + exchangeAdjustment
 * (orderDiscounts + posDiscounts are already baked into orderRevenue/posRevenue
 * — both are read post-discount — so they are a reporting field only, not
 * subtracted again here; see totalDiscounts below.)
 */
export async function computeNetProfit(opts: {
  branchId?: number;
  dateFrom?: string;
  dateTo?: string;
}): Promise<NetProfitResult> {
  const FULFILLED_STATUSES = `('FULFILLED','COMPLETED','Fulfilled','Completed')`;

  // ── Build per-query filter params ─────────────────────────────────────────

  const { conditions: revConds, params: revParams } = buildOrderFilters(opts);
  const revWhere = `o.status IN ${FULFILLED_STATUSES}` +
    (revConds.length ? ' AND ' + revConds.join(' AND ') : '');

  const { conditions: costConds, params: costParams } = buildOrderFilters(opts);
  const costWhere = `o.status IN ${FULFILLED_STATUSES}` +
    (costConds.length ? ' AND ' + costConds.join(' AND ') : '');

  const returnParams: unknown[] = [];
  const returnConds: string[] = [`r.status IN ('completed','Completed','Approved','APPROVED')`];
  if (opts.branchId !== undefined) { returnParams.push(opts.branchId); returnConds.push(`r.branch_id = $${returnParams.length}`); }
  if (opts.dateFrom) { returnParams.push(opts.dateFrom); returnConds.push(`r.created_at::date >= $${returnParams.length}::date`); }
  if (opts.dateTo)   { returnParams.push(opts.dateTo);   returnConds.push(`r.created_at::date <= $${returnParams.length}::date`); }

  const exchParams: unknown[] = [];
  const exchConds: string[] = [`e.status IN ('Completed','COMPLETED')`];
  if (opts.branchId !== undefined) { exchParams.push(opts.branchId); exchConds.push(`e.branch_id = $${exchParams.length}`); }
  if (opts.dateFrom) { exchParams.push(opts.dateFrom); exchConds.push(`e.created_at::date >= $${exchParams.length}::date`); }
  if (opts.dateTo)   { exchParams.push(opts.dateTo);   exchConds.push(`e.created_at::date <= $${exchParams.length}::date`); }

  const recvParams: unknown[] = ['order_credit_sale'];
  // Include both Settled (fully paid) and PartiallyPaid (partial collection) receivables.
  // For both: collected portion = original_amount − outstanding_amount.
  const recvConds: string[] = [`r.source_type = $1`, `r.outstanding_amount < r.original_amount`];
  if (opts.branchId !== undefined) { recvParams.push(opts.branchId); recvConds.push(`r.branch_id = $${recvParams.length}`); }
  if (opts.dateFrom) { recvParams.push(opts.dateFrom); recvConds.push(`r.created_at::date >= $${recvParams.length}::date`); }
  if (opts.dateTo)   { recvParams.push(opts.dateTo);   recvConds.push(`r.created_at::date <= $${recvParams.length}::date`); }

  const outParams: unknown[] = ['order_credit_sale'];
  const outConds: string[] = [`r.source_type = $1`, `r.status IN ('Pending','PartiallyPaid','Overdue')`];
  if (opts.branchId !== undefined) { outParams.push(opts.branchId); outConds.push(`r.branch_id = $${outParams.length}`); }
  if (opts.dateFrom) { outParams.push(opts.dateFrom); outConds.push(`r.created_at::date >= $${outParams.length}::date`); }
  if (opts.dateTo)   { outParams.push(opts.dateTo);   outConds.push(`r.created_at::date <= $${outParams.length}::date`); }

  // POS: grand_total = revenue (after discounts already applied at line level)
  // discount_total = total discounts given on completed transactions
  const posParams: unknown[] = [];
  const posConds: string[] = [`t.status = 'completed'`];
  if (opts.branchId !== undefined) { posParams.push(opts.branchId); posConds.push(`t.branch_id = $${posParams.length}`); }
  if (opts.dateFrom) { posParams.push(opts.dateFrom); posConds.push(`t.created_at::date >= $${posParams.length}::date`); }
  if (opts.dateTo)   { posParams.push(opts.dateTo);   posConds.push(`t.created_at::date <= $${posParams.length}::date`); }

  // POS cost query — separate param set (clean $1, $2, $3 indexing)
  const posCostParams: unknown[] = [];
  const posCostConds: string[] = [`t.status = 'completed'`];
  if (opts.branchId !== undefined) { posCostParams.push(opts.branchId); posCostConds.push(`t.branch_id = $${posCostParams.length}`); }
  if (opts.dateFrom) { posCostParams.push(opts.dateFrom); posCostConds.push(`t.created_at::date >= $${posCostParams.length}::date`); }
  if (opts.dateTo)   { posCostParams.push(opts.dateTo);   posCostConds.push(`t.created_at::date <= $${posCostParams.length}::date`); }
  const posCostWhere = posCostConds.join(' AND ');

  // ── Execute all 8 queries in parallel ────────────────────────────────────
  const [
    revenueRes,
    orderCostRes,
    posCostRes,
    returnsRes,
    returnsCostRes,
    exchangeRes,
    collectedRes,
    outstandingRes,
    posRes,
  ] = await Promise.all([
    // Q1: Order revenue — cash-sale and fully-paid credit orders recognized immediately.
    //     Unpaid credit orders are excluded from SUM(o.total); their collected portion
    //     is picked up via Q5 (receivable.original_amount − outstanding_amount).
    //     Partially-paid credit: also excluded from o.total — collected portion via Q5.
    //     This prevents double-counting: we never count o.total AND the receivable amount.
    db.query(
      `SELECT
         -- Cash sales: always recognized in full
         COALESCE(SUM(CASE WHEN o.sale_type = 'cash_sale' THEN o.total ELSE 0 END), 0)::NUMERIC AS cash_sales_revenue,
         -- Credit sales that are fully paid: recognized via receivable (Q5), NOT here
         -- (we exclude all credit sales from o.total to avoid double-counting with Q5)
         0::NUMERIC AS credit_sales_revenue_direct,
         -- Order discounts from cash sales only (credit discounts reduce the receivable amount)
         COALESCE(SUM(CASE WHEN o.sale_type = 'cash_sale' THEN o.discount_total ELSE 0 END), 0)::NUMERIC AS total_discounts
       FROM orders o
       WHERE ${revWhere}`,
      revParams,
    ),
    // Q2a: Order-based purchase cost. Sales Posting Rule: COGS is the unit
    // cost frozen on the line item at the moment it was posted (oli.unit_cost)
    // — never recomputed against whatever procurement has done since. Falls
    // back to costBasis.ts's most-recent-cost lookup only for rows that
    // predate that persistence (oli.unit_cost IS NULL).
    db.query(
      `SELECT COALESCE(SUM(COALESCE(oli.unit_cost, lc.unit_cost, 0) * oli.quantity), 0)::NUMERIC AS purchase_cost
       FROM order_line_items oli
       JOIN orders o ON o.id = oli.order_id
       ${costBasisLateralJoin('oli.book_id')}
       WHERE ${costWhere}`,
      costParams,
    ),
    // Q2b: POS-based purchase cost — same preference for the persisted
    // sale-time cost over the historical fallback. Excludes credit POS from
    // cost too (not recognized yet).
    db.query(
      `SELECT COALESCE(SUM(COALESCE(tli.unit_cost, lc.unit_cost, 0) * tli.quantity), 0)::NUMERIC AS purchase_cost
       FROM transaction_line_items tli
       JOIN transactions t ON t.id = tli.transaction_id
       ${costBasisLateralJoin('tli.book_id')}
       WHERE ${posCostWhere} AND t.payment_status != 'credit'`,
      posCostParams,
    ),
    // Q3: Returns value
    db.query(
      `SELECT COALESCE(SUM(rli.unit_price * rli.quantity), 0)::NUMERIC AS returns_value
       FROM return_line_items rli
       JOIN returns r ON r.id = rli.return_id
       WHERE ${returnConds.join(' AND ')}`,
      returnParams,
    ),
    // Q3b: Returns cost credit-back. Return Posting Rule: "COGS decreases"
    // and "gross profit decreases by the original margin" — not by the
    // full revenue amount. purchaseCost (Q2b) still includes the original
    // sale's cost even after it's returned (there's no return-awareness in
    // that query), so this credits it back at the SAME original cost the
    // return itself was restocked at (transaction_line_items.unit_cost, via
    // the same transaction_line_item_id link returns.service.ts uses to
    // restore inventory) — not the current average, which could have moved
    // since. NULL for sales that predate cost persistence, matching Q2b's
    // own fallback boundary (no historical fallback here — the return
    // itself couldn't have used one either, so crediting one back now that
    // Q2b never charged in the first place would be a phantom credit).
    db.query(
      `SELECT COALESCE(SUM(COALESCE(tli.unit_cost, 0) * rli.quantity), 0)::NUMERIC AS returns_cost
       FROM return_line_items rli
       JOIN returns r ON r.id = rli.return_id
       JOIN transaction_line_items tli ON tli.id = rli.transaction_line_item_id
       WHERE ${returnConds.join(' AND ')}`,
      returnParams,
    ),
    // Q4: Exchange cash adjustment
    db.query(
      `SELECT COALESCE(SUM(
         CASE WHEN ese.entry_type = 'cash_payment' THEN ese.amount
              WHEN ese.entry_type = 'cash_refund'  THEN -ese.amount
              ELSE 0 END), 0)::NUMERIC AS exchange_adjustment
       FROM exchange_settlement_entries ese
       JOIN exchanges e ON e.id = ese.exchange_id
       WHERE ${exchConds.join(' AND ')}`,
      exchParams,
    ),
    // Q5: Collected credit revenue — the SINGLE source for all credit order revenue.
    //     Covers both 'Settled' (fully paid) and 'PartiallyPaid' receivables.
    //     collected = original_amount − outstanding_amount (works for both full and partial).
    db.query(
      `SELECT COALESCE(SUM(r.original_amount - r.outstanding_amount), 0)::NUMERIC AS collected_credit_revenue
       FROM receivables r WHERE ${recvConds.join(' AND ')}`,
      recvParams,
    ),
    // Q6: Outstanding receivables
    db.query(
      `SELECT COALESCE(SUM(r.outstanding_amount), 0)::NUMERIC AS outstanding_receivables
       FROM receivables r WHERE ${outConds.join(' AND ')}`,
      outParams,
    ),
    // Q7: POS cash-only revenue — EXCLUDE credit POS (payment_status = 'credit').
    //     Credit POS revenue is recognized only when collected (separate mechanism).
    db.query(
      `SELECT
         COALESCE(SUM(t.grand_total),    0)::NUMERIC AS pos_revenue,
         COALESCE(SUM(t.discount_total), 0)::NUMERIC AS pos_discounts
       FROM transactions t
       WHERE ${posConds.join(' AND ')} AND t.payment_status != 'credit'`,
      posParams,
    ),
  ]);

  // ── Extract and combine all channels ─────────────────────────────────────
  const rev                = revenueRes.rows[0];
  const cashSalesRevenue   = parseFloat(rev.cash_sales_revenue   as string);
  const orderDiscounts     = parseFloat(rev.total_discounts      as string);

  const purchaseCost       = parseFloat(orderCostRes.rows[0].purchase_cost as string)
                           + parseFloat(posCostRes.rows[0].purchase_cost   as string);
  const returnsValue       = parseFloat(returnsRes.rows[0].returns_value               as string);
  const returnsCost        = parseFloat(returnsCostRes.rows[0].returns_cost             as string);
  const exchangeAdjustment = parseFloat(exchangeRes.rows[0].exchange_adjustment        as string);
  const collectedCreditRevenue = parseFloat(collectedRes.rows[0].collected_credit_revenue as string);
  const outstandingReceivables = parseFloat(outstandingRes.rows[0].outstanding_receivables as string);

  const posRevenue   = parseFloat(posRes.rows[0].pos_revenue   as string);
  const posDiscounts = parseFloat(posRes.rows[0].pos_discounts as string);

  // Credit order revenue = collected portion from receivables (not from o.total)
  const creditSalesRevenue = collectedCreditRevenue;

  // Recognized revenue = cash order revenue + collected credit order revenue + cash POS revenue
  // Credit POS and unpaid/partial credit orders are excluded until payment is collected.
  const fulfilledRevenue = cashSalesRevenue + collectedCreditRevenue + posRevenue;
  const totalDiscounts   = orderDiscounts + posDiscounts;

  // Net profit formula:
  // Revenue (grand_total / o.total) is ALREADY post-discount — the customer
  // paid the discounted price. Subtracting discounts again would double-count.
  // Correct formula: Revenue − Cost − Returns + Returns Cost ± Exchange Adjustments
  // totalDiscounts is kept as a reporting field (shown in KPI card) but NOT subtracted.
  // Return Posting Rule: a return should reduce gross profit by the ORIGINAL
  // margin, not by the full revenue amount — returnsValue alone (revenue-only
  // reversal) would double-penalize profit, since purchaseCost above still
  // includes the returned units' original cost. +returnsCost credits that
  // back, leaving the net effect of a return on profit equal to exactly the
  // margin that sale contributed in the first place.
  const netProfit = fulfilledRevenue - purchaseCost - returnsValue + returnsCost + exchangeAdjustment;

  return {
    netProfit,
    fulfilledRevenue,
    purchaseCost,
    totalDiscounts,
    returnsValue,
    returnsCost,
    exchangeAdjustment,
    cashSalesRevenue,
    creditSalesRevenue,
    collectedCreditRevenue,
    outstandingReceivables,
  };
}
