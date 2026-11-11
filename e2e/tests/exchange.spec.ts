import { expect, test } from '@playwright/test';
import { Shop, signIn } from '../support/shop';

// An exchange: a customer trades a book in and takes another, paying the difference in cash.
test('exchange with the difference paid in cash', async ({ page, request }) => {
  const shop = await Shop.open(request);
  const tradeIn = await shop.book({ price: '200.00', copies: 0, cost: '0' });
  const taken = await shop.book({ price: '300.00', copies: 2, cost: '180.00' });
  const customer = await shop.customer();
  await signIn(page);

  await page.goto('/exchanges');
  await page.getByRole('button', { name: /Quick Exchange/i }).click();
  await page.getByPlaceholder(/Search customer by name or code/i).fill(customer.name);
  await page.getByText(customer.name).first().click();

  await page.getByRole('button', { name: /Add Incoming/i }).click();
  await page.getByPlaceholder(/Search books to add as/i).fill(tradeIn.isbn);
  await page.getByText(tradeIn.title).first().click();
  await page.getByLabel(`Allowance for ${tradeIn.title}`).fill('200');

  await page.getByRole('button', { name: /Add Outgoing/i }).click();
  await page.getByPlaceholder(/Search books to add as/i).fill(taken.isbn);
  await page.getByText(taken.title).first().click();

  await page.getByRole('button', { name: 'Complete Exchange' }).click();

  // The exchange is listed, the customer paid the 100.00 difference, and it is settled.
  const row = page.getByRole('row').filter({ hasText: /EXC-\d{8}-\d{4}/ }).first();
  await expect(row).toContainText('ETB 200.00');
  await expect(row).toContainText('ETB 300.00');
  await expect(row).toContainText('+100.00');
  await expect(row).toContainText('Settled');
  expect(await shop.stock(taken.id)).toBe(1);
  expect(await shop.stock(tradeIn.id)).toBe(1);
});
