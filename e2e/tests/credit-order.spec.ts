import { expect, test } from '@playwright/test';
import { Shop, signIn } from '../support/shop';

// A customer order on credit: created with its due date, delivered, then paid in Payments.
test('credit order, delivered, then paid', async ({ page, request }) => {
  const shop = await Shop.open(request);
  const book = await shop.book({ price: '400.00', copies: 3, cost: '250.00' });
  const customer = await shop.customer();
  await signIn(page);

  await page.goto('/orders');
  await page.getByRole('button', { name: /New Order/i }).click();
  await page.getByPlaceholder('Search customer...').fill(customer.name);
  await page.getByText(customer.name).first().click();
  await page.getByPlaceholder('Search books to add...').fill(book.isbn);
  await page.getByText(book.title).first().click();
  await page.getByRole('button', { name: /Credit Sale/i }).click();
  await page.getByLabel('Due date').fill('2099-12-31');
  await page.getByRole('button', { name: /Create Order/i }).click();

  const row = page.getByRole('row').filter({ hasText: customer.name });
  await expect(row).toContainText('Confirmed');
  await expect(row).toContainText('ETB 400.00');
  const order = /ORD-\d{8}-\d{4}/.exec(await row.innerText())![0];

  await row.getByRole('button', { name: 'Deliver…' }).click();
  const deliver = page.getByRole('dialog', { name: `Deliver ${order}` });
  await deliver.getByLabel(`Copies of ${book.title} to deliver`).fill('1');
  await deliver.getByRole('button', { name: 'Deliver' }).click();
  await expect(deliver).toBeHidden();
  expect(await shop.stock(book.id)).toBe(2);

  await page.goto('/payments');
  const unpaid = page.getByRole('row').filter({ hasText: order });
  await unpaid.getByRole('button', { name: /Collect/ }).click();
  await expect(page.getByText('Outstanding')).toBeVisible();
  await page.getByRole('button', { name: /Record Payment — ETB 400\.00/ }).click();
  await expect(page.getByRole('row').filter({ hasText: order })).toHaveCount(0);

  // What the customer owed is settled, and the order is complete and paid.
  await page.goto('/receivables');
  const owed = page.getByRole('row').filter({ hasText: order });
  await expect(owed).toContainText('Settled');
  await expect(owed).toContainText('ETB 0.00');
  await page.goto('/orders');
  const done = page.getByRole('row').filter({ hasText: order });
  await expect(done).toContainText('Completed');
  await expect(done).toContainText('paid');
});
