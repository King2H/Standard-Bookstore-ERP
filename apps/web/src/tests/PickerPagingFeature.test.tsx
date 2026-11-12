// #266 (owner decision a, 2026-11-12): a picker of records reaches every
// record, whatever the number. It asks the API for matches a page at a time,
// says how many there are ("20 of 45"), and shows more on request or as the
// list scrolls. Before, pickers showed one page with no count, and several
// lists (branches, bank accounts, services, draft orders) were dropdowns of
// the first 100, the rest out of reach. No screen fetches a fixed first page
// of records for a list any more.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { SearchPicker, type PickerOption, type PickerPage } from '../shared/components/SearchPicker.js';

const RECORDS: PickerOption[] = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, label: `Branch ${String(i + 1).padStart(2, '0')}` }));

/** What a paged list endpoint answers: matches in part, any case, 20 a page. */
async function search(text: string, page: number): Promise<PickerPage> {
  const found = RECORDS.filter((r) => r.label.toLowerCase().includes(text.toLowerCase()));
  return { items: found.slice((page - 1) * 20, page * 20), total: found.length };
}

function Harness() {
  const [value, setValue] = useState<PickerOption | null>(null);
  return (
    <>
      <SearchPicker value={value} onChange={setValue} search={search} queryKey="test-branches" aria-label="Branch" />
      <p>Chosen: {value?.label ?? 'none'}</p>
    </>
  );
}

function renderHarness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>);
}

describe('A picker of records (#266)', () => {
  it('says how many there are, and shows more until every one is offered', async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.click(screen.getByRole('combobox', { name: 'Branch' }));
    const list = await screen.findByRole('listbox');
    expect(await within(list).findByText('Showing 20 of 45')).toBeInTheDocument();
    expect(within(list).getAllByRole('option')).toHaveLength(20);

    await user.click(within(list).getByRole('button', { name: 'Show more' }));
    expect(await within(list).findByText('Showing 40 of 45')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Show more' }));
    expect(await within(list).findByText('Showing 45 of 45')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();

    // The last record, past the first two pages, is chosen like any other.
    await user.click(within(list).getByRole('option', { name: 'Branch 45' }));
    expect(screen.getByText('Chosen: Branch 45')).toBeInTheDocument();
  });

  it('searches every record as it is typed, with the count of matches', async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.type(screen.getByRole('combobox', { name: 'Branch' }), '4');
    const list = await screen.findByRole('listbox');
    // Branch 04, 14, 24, 34, 40–45.
    expect(await within(list).findByText('Showing 10 of 10')).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: 'Branch 44' })).toBeInTheDocument();
  });

  it('keeps what is typed over a choice, and searches it (was: the box emptied as the old choice was let go)', async () => {
    const user = userEvent.setup();
    renderHarness();
    const box = screen.getByRole('combobox', { name: 'Branch' });
    await user.type(box, '45');
    await user.click(await screen.findByRole('option', { name: 'Branch 45' }));
    expect(screen.getByText('Chosen: Branch 45')).toBeInTheDocument();

    // Typed over the chosen name, as a person replaces it.
    await user.tripleClick(box);
    await user.keyboard('12');
    expect(box).toHaveValue('12');
    expect(screen.getByText('Chosen: none')).toBeInTheDocument();
    const list = await screen.findByRole('listbox');
    expect(await within(list).findByRole('option', { name: 'Branch 12' })).toBeInTheDocument();
    expect(within(list).getAllByRole('option')).toHaveLength(1);
  });

  it('says when nothing matches', async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.type(screen.getByRole('combobox', { name: 'Branch' }), 'Nowhere');
    expect(await within(await screen.findByRole('listbox')).findByText('No matches')).toBeInTheDocument();
  });
});

describe('No screen lists a fixed first page of records (#266)', () => {
  const SRC = resolve(__dirname, '..');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

  it('asks for no page of 50 or more: a list pages, a picker searches', () => {
    const found = files(SRC).flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return [...text.matchAll(/pageSize(?:\s*:\s*|=)(\d+)/g)]
        .filter((m) => Number(m[1]) >= 50)
        .map((m) => `${relative(SRC, path)}: ${m[0]}`);
    });
    expect(found).toEqual([]);
  });

  it('keeps no list of open branches loaded whole', () => {
    const found = files(SRC).filter((path) => readFileSync(path, 'utf8').includes('useOpenBranches')).map((p) => relative(SRC, p));
    expect(found).toEqual([]);
  });
});
