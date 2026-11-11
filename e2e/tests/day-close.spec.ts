import { expect, test } from '@playwright/test';
import { Shop, signIn } from '../support/shop';
import { sellAtCounter } from '../support/screens';

/** Today in the shop's time zone, as the day close names it. */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.E2E_TIMEZONE ?? 'Africa/Addis_Ababa' }).format(new Date());

// The end of the day: the cash drawer counted and closed, then the branch's day closed with its report.
// It runs after every other journey: nothing more can be recorded in the branch that day.
test('cash drawer counted, then the day closed', async ({ page, request }) => {
  const shop = await Shop.open(request);
  const book = await shop.book({ price: '150.00', copies: 2, cost: '90.00' });
  await signIn(page);

  await page.goto('/pos');
  await page.getByRole('button', { name: /Cash Drawer/ }).click();
  await page.getByLabel('Opening float').fill('100');
  await page.getByRole('button', { name: 'Open session' }).click();
  await expect(page.getByText('Cash session open')).toBeVisible();

  await sellAtCounter(page, book);

  await page.goto('/pos');
  await page.getByRole('button', { name: /Cash Drawer/ }).click();
  await page.getByRole('button', { name: 'Close session' }).click();
  const count = page.getByRole('dialog');
  await count.getByLabel('Cash counted').fill('250');
  await count.getByRole('button', { name: 'Close session' }).click();
  await expect(count).toBeHidden();

  await page.goto('/day-close');
  await page.getByRole('button', { name: `${today()} Open` }).click();
  const panel = page.getByRole('region', { name: `Day ${today()}` });
  // The report so far: the day's sales and the drawer counted even.
  await expect(panel.getByText('POS sales')).toBeVisible();
  await expect(panel.getByRole('row').filter({ hasText: /Z-\d{8}-\d{4}/ }).last()).toContainText('Even');

  await panel.getByRole('button', { name: 'Close day' }).click();
  const confirm = page.getByRole('dialog', { name: `Close ${today()}?` });
  await confirm.getByRole('button', { name: 'Close day' }).click();
  await expect(page.getByText(/DAY-\d{8}-\d{4} · closed by/)).toBeVisible();

  // The day is kept as closed, with its report.
  await page.goto('/day-close');
  await expect(page.getByRole('button', { name: `${today()} Closed` })).toBeVisible();
});
