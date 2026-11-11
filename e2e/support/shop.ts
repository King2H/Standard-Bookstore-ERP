import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * What each journey needs, set up through the API (#33, owner decision 2a):
 * its own books, stock, customer and supplier, so that journeys run in any
 * order and a failure points at one journey. The journey itself is done
 * through the screens.
 */

export const ADMIN = {
  username: process.env.E2E_ADMIN_USER ?? 'admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'Admin@1234',
};
/** The location every new install has. */
export const LOCATION = process.env.E2E_LOCATION ?? 'Main Floor';

let serial = 0;
/** A name no other run or journey has: the journeys share one shop. */
export const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(serial++).toString(36)}`;

/** A valid ISBN-13 that no other journey uses. */
export function isbn13(): string {
  const digits = `978${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  const sum = [...digits].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return digits + ((10 - (sum % 10)) % 10);
}

export interface Book { id: number; isbn: string; title: string; price: string }
export interface Customer { id: number; code: string; name: string }
export interface Supplier { id: number; name: string }

export class Shop {
  private constructor(private readonly api: APIRequestContext, private readonly headers: Record<string, string>) {}

  /** Signs in to the API as the Admin, as the screens do: the access token, and the CSRF cookie sent back in its header. */
  static async open(api: APIRequestContext): Promise<Shop> {
    const res = await api.post('/api/v1/auth/login', { data: { ...ADMIN, branchId: 1 } });
    expect(res.status(), await res.text()).toBe(200);
    const csrf = (await api.storageState()).cookies.find((c) => c.name === 'csrf-token')?.value ?? '';
    return new Shop(api, { Authorization: `Bearer ${(await res.json()).accessToken as string}`, 'X-CSRF-Token': csrf });
  }

  async call<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, data?: unknown): Promise<T> {
    const res = await this.api.fetch(`/api/v1${path}`, { method, data, headers: this.headers });
    expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
  }

  /** Brings a file in through Import / Export, all rows or none. */
  private async import(kind: string, csv: string): Promise<void> {
    await this.call('POST', `/imports/${kind}`, { csv, fileName: `e2e-${kind}.csv` });
  }

  /** A new book with copies at the location, at a cost. */
  async book(opts: { price: string; copies: number; cost: string; title?: string }): Promise<Book> {
    const isbn = isbn13();
    const title = opts.title ?? unique('E2E Book');
    await this.import('catalog', `ISBN,Title,Price\r\n${isbn},${title},${opts.price}`);
    if (opts.copies > 0) {
      await this.import('opening-stock', `ISBN,Location,Quantity,Unit Cost\r\n${isbn},${LOCATION},${opts.copies},${opts.cost}`);
    }
    const found = await this.call<{ data?: Array<{ id: number; isbn: string }>; items?: Array<{ id: number; isbn: string }> }>(
      'GET', `/books?search=${isbn}`,
    );
    const book = (found.data ?? found.items ?? []).find((b) => b.isbn === isbn);
    expect(book, `book ${isbn} after import`).toBeTruthy();
    return { id: book!.id, isbn, title, price: opts.price };
  }

  async customer(): Promise<Customer> {
    const name = unique('E2E Customer');
    const created = await this.call<{ id: number; customerCode: string }>('POST', '/customers', { fullName: name });
    return { id: created.id, code: created.customerCode, name };
  }

  async supplier(): Promise<Supplier> {
    const name = unique('E2E Supplier');
    const created = await this.call<{ id: number }>('POST', '/suppliers', { name, contactInfo: {}, supplierType: 'external' });
    return { id: created.id, name };
  }

  /** Copies of a book on hand, at every location. */
  async stock(bookId: number): Promise<number> {
    return (await this.inventory(bookId)).reduce((n, r) => n + r.quantity, 0);
  }

  /** A book's stock lines: copies and what one cost on average, per location. */
  async inventory(bookId: number): Promise<Array<{ quantity: number; averageCost: number }>> {
    const { items } = await this.call<{ items: Array<{ bookId: number; quantity: number; averageCost: number }> }>('GET', `/inventory?bookId=${bookId}`);
    return items.filter((r) => r.bookId === bookId);
  }
}

/** Signs in on the screens as the Admin. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.fill('#login-username', ADMIN.username);
  await page.fill('#login-password', ADMIN.password);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
