import { expect, test } from '@playwright/test';
import { Shop, signIn } from '../support/shop';
import { sellAtCounter } from '../support/screens';

// A counter sale paid in cash: the receipt, the sale in the history, the copy gone from stock.
test('POS sale paid in cash', async ({ page, request }) => {
  const shop = await Shop.open(request);
  const book = await shop.book({ price: '300.00', copies: 5, cost: '200.00' });
  await signIn(page);

  const number = await sellAtCounter(page, book);

  await expect(page.getByText(`Sale ${number} completed`)).toBeVisible();
  await expect(page.getByText('ETB 300.00').first()).toBeVisible();
  expect(await shop.stock(book.id)).toBe(4);

  await page.goto('/pos');
  await page.getByRole('button', { name: /Sales History/ }).click();
  await expect(page.getByText(number)).toBeVisible();
});
