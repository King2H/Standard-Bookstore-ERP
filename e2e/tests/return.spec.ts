import { expect, test } from '@playwright/test';
import { Shop, signIn } from '../support/shop';
import { sellAtCounter } from '../support/screens';

// A counter sale returned: the return slip, the copies back in stock.
test('return of a counter sale', async ({ page, request }) => {
  const shop = await Shop.open(request);
  const book = await shop.book({ price: '250.00', copies: 3, cost: '150.00' });
  await signIn(page);
  const sale = await sellAtCounter(page, book);
  expect(await shop.stock(book.id)).toBe(2);

  await page.goto('/returns');
  await page.getByRole('textbox', { name: 'Transaction or order number' }).fill(sale);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: /Use this transaction/ }).click();
  await page.getByRole('spinbutton').fill('1');
  await page.getByRole('textbox', { name: 'Reason for return' }).fill('Bought twice');
  await page.getByRole('button', { name: 'Process Return' }).click();

  const slip = page.getByRole('dialog', { name: /^Return RET-/ });
  await expect(slip).toContainText(book.title);
  await expect(slip).toContainText('250.00');
  expect(await shop.stock(book.id)).toBe(3);
});
