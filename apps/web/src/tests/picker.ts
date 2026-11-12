import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/**
 * Chooses a record in a picker (#266): types into the box named `name`
 * (within `scope`), then clicks the option whose name matches.
 */
export async function pick(user: UserEvent, name: string | RegExp, text: string, option: string | RegExp, scope: HTMLElement = document.body) {
  const box = within(scope).getByRole('combobox', { name });
  await user.clear(box);
  if (text) await user.type(box, text);
  else await user.click(box);
  await user.click(await screen.findByRole('option', { name: option }));
}

/** A page of `items` that match `q` by `label`, as the list endpoints answer (#266). */
export function pageOf<T>(items: T[], url: URL, label: (item: T) => string) {
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  const pageSize = Number(url.searchParams.get('pageSize') ?? 20);
  const page = Number(url.searchParams.get('page') ?? 1);
  const found = items.filter((i) => label(i).toLowerCase().includes(q));
  return { items: found.slice((page - 1) * pageSize, page * pageSize), total: found.length, page, pageSize, totalPages: Math.max(1, Math.ceil(found.length / pageSize)) };
}
