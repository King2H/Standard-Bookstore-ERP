// #267 (owner decision a, 2026-11-12): every price and cost field says in
// plain words what it is, under the field and read with it. A binding's fee
// is what the customer pays for it, apart from the book's price; its
// standard cost is what the binder is expected to charge, the cost a sale
// records; a book's default price is what it sells for, which inventory is
// not valued at; its trade value is what a customer is offered for it on an
// exchange. Before, the fields had a label only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ServiceForm } from '../features/services/components/ServiceForm.js';
import { BookFormDrawer } from '../features/catalog/components/BookFormDrawer.js';
import { ToastProvider } from '../components/Toast.js';
import { setAccessToken } from '../lib/api.js';

beforeEach(() => {
  setAccessToken('x');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url.replace(/^.*\/api\/v1/, ''), 'http://x').pathname;
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path === '/config/currency') return json({ currency: 'ETB' });
    if (path === '/book-formats' || path === '/book-editions') return json({ items: [{ id: 1, label: 'Hardcover' }] });
    return json({ items: [], total: 0 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

function renderWith(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider>{node}</ToastProvider></QueryClientProvider>);
}

describe('A binding service (#267)', () => {
  it('explains the fee, apart from the book\'s price, and the standard cost against the actual one', async () => {
    renderWith(<ServiceForm editing={null} saving={false} error="" onSave={() => {}} onClose={() => {}} />);
    expect(await screen.findByLabelText('Fee (ETB) *')).toHaveAccessibleDescription(
      'What the customer pays to bind one copy, on its own line beside the book, whose price does not change. A branch may set its own fee.',
    );
    expect(screen.getByLabelText('Standard cost (ETB) *')).toHaveAccessibleDescription(
      'What the binder is expected to charge for one copy: the binding\'s cost in gross profit when it is sold. The actual cost is entered when the job comes back; any difference shows as the binding cost difference.',
    );
    expect(screen.getByLabelText('Turnaround (days) *')).toHaveAccessibleDescription('Days from the sale until it is ready: the ready date the customer is given.');
  });
});

describe('A book\'s prices (#267)', () => {
  it('explains the default price, which stock is not valued at, and the trade value', async () => {
    const user = userEvent.setup();
    renderWith(<BookFormDrawer book={null} currency="ETB" onClose={() => {}} onSaved={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Pricing' }));
    expect(screen.getByLabelText('Default Price (ETB)')).toHaveAccessibleDescription(
      'What the book sells for, tax included when tax is on; a branch may set its own. Stock is valued at its average cost, not at this price.',
    );
    expect(screen.getByLabelText('Trade Value (ETB)')).toHaveAccessibleDescription(
      'What a customer is offered for this book when trading it in on an exchange; it can be changed there.',
    );
  });
});
