import { expect, test, type Page } from '@playwright/test';
import { LOCATION, Shop, signIn } from '../support/shop';

/** A step of the purchase order's detail page, and its next state. */
async function act(page: Page, button: string) {
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect(page.getByRole('button', { name: button, exact: true })).toBeHidden();
}

// A purchase order above the approval limit: approved, ordered, received into stock at its cost.
test('purchase order approved and received', async ({ page, request }) => {
  const shop = await Shop.open(request);
  const book = await shop.book({ price: '500.00', copies: 0, cost: '0' });
  const supplier = await shop.supplier();
  await signIn(page);

  await page.goto('/procurement');
  await page.getByRole('button', { name: /New PO/ }).click();
  await page.getByPlaceholder('Type to search suppliers…').fill(supplier.name);
  await page.getByRole('option', { name: supplier.name }).click();
  await page.getByPlaceholder('Type to search books…').fill(book.isbn);
  // The book list picks on mouse down, before the field loses focus.
  await page.getByText(book.title).first().dispatchEvent('mousedown');
  const [quantity, unitCost] = [page.locator('main input[type=number]').nth(0), page.locator('main input[type=number]').nth(1)];
  await quantity.fill('4');
  await unitCost.fill('320');
  await page.getByRole('button', { name: 'Save as Draft' }).click();

  await expect(page.getByText(/^PO-\d{8}-\d{4}$/)).toBeVisible();
  await expect(page.getByText('Total: ETB 1280.00')).toBeVisible();
  // 1280.00 is above what a submit approves by itself: an Admin approves it.
  await act(page, 'Submit for Approval');
  await act(page, 'Approve');
  await act(page, 'Mark as Ordered');

  await page.getByRole('button', { name: 'Receive Goods' }).click();
  await page.getByRole('combobox').first().selectOption({ label: `${LOCATION} (default)` });
  await page.getByLabel(`Quantity to receive of ${book.title}`).fill('4');
  await page.getByRole('button', { name: 'Submit Receipt' }).click();

  await expect(page.getByText('4 / 4 units')).toBeVisible();
  await expect(page.getByText('received', { exact: true })).toBeVisible();
  expect(await shop.inventory(book.id)).toEqual([expect.objectContaining({ quantity: 4, averageCost: 320 })]);
});
