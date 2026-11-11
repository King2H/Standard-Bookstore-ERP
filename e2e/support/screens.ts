import { expect, type Page } from '@playwright/test';
import type { Book, Customer } from './shop';

/** Steps several journeys take on the screens. */

/** Sells copies of a book at the POS, paid in cash, and returns the sale's number from the receipt. */
export async function sellAtCounter(page: Page, book: Book, opts: { customer?: Customer } = {}): Promise<string> {
  await page.goto('/pos');
  if (opts.customer) {
    await page.getByPlaceholder('Search customer… (F9)').fill(opts.customer.name);
    await page.getByText(opts.customer.name).first().click();
  }
  await page.getByPlaceholder('Title, ISBN, Author…').fill(book.isbn);
  await page.getByText(book.title).first().click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: /Complete Sale/ }).click();
  const done = page.getByText(/^Sale POS-\d{8}-\d{4} completed$/);
  await expect(done).toBeVisible();
  return /POS-\d{8}-\d{4}/.exec(await done.innerText())![0];
}
