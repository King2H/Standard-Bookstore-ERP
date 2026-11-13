/**
 * What each figure of the dashboard's sections means, in plain words (#268,
 * owner decision a): one line under the figure, the same wherever it is
 * shown. "The dates chosen" are the toolbar's From and To (or the whole
 * history when empty); "the period" is the Today/Week/Month/Year shown.
 * Each line says what the API counts (reports/*.repository.ts).
 */
export const GLOSSARY = {
  // Sales Trend
  'Order Sales': 'Customer orders confirmed or later in the dates chosen; drafts and cancelled orders are not sales.',
  'POS Sales': 'Counter sales in the dates chosen, as rung up at the till.',
  'Orders': 'How many customer orders were confirmed or later in the dates chosen.',
  'Avg Order': 'Order sales divided by the number of orders.',
  'Tax included': 'The tax inside net sales, at the rate each sale was made at. Prices include tax.',
  'Net sales before tax': 'Net sales less the tax they include.',
  'Book Sales': 'What books sold for, after discounts, on orders and counter sales.',
  'Service Income': 'Binding fees charged, after discounts, on orders, counter sales and exchanges.',
  'Gross Profit': 'Net sales less what was sold cost: books at their average cost, bindings at their standard cost.',
  'Binding cost difference': 'What binders charged above the standard cost (below it, a negative figure), counted the day each job came back.',
  'Cash over/short': 'Cash counted at closed cash sessions less the cash expected: over is positive, short is negative.',
  'Net Profit': 'Gross profit less the binding cost difference, plus cash over or less cash short.',
  // Discount Summary
  'Total Discounts': 'All discounts given on sale lines in the dates chosen.',
  'Normal': 'Discounts given with the Normal preset.',
  'Merchant': 'Discounts given with the Merchant preset.',
  'Special': 'Discounts given with the Special preset.',
  // Payment Methods
  'Collected': 'All money received in the period, every payment method.',
  'Refunded': 'All money paid back to customers in the period.',
  // Exchange Activity
  'Total Exchanges': 'Exchanges made in the dates chosen.',
  'Net Impact': 'What customers paid on exchanges less what the shop paid back.',
  'Incoming Value': 'What the shop allowed for the books customers brought in.',
  'Outgoing Value': 'What the books customers took away sell for.',
  // Inventory Insights
  'Books': 'Titles the shop holds stock records for.',
  'Units': 'Copies on hand at every location.',
  'Available': 'Copies free to sell: an order\'s copies leave stock when it is confirmed, so this is the copies on hand.',
  'Reserved': 'Copies set aside for confirmed orders not yet delivered; they have already left the units on hand.',
  // Customer Insights
  'Total': 'Every customer on record.',
  'Active': 'Customers whose account is active now.',
  'Repeat': 'Customers with more than one sale in the dates chosen.',
  'New (period)': 'Customers added in the dates chosen.',
} as const;

export type FigureLabel = keyof typeof GLOSSARY;
