/** A record a picker offers: its id and what it shows. */
export interface PickerOption {
  id: number;
  label: string;
}

/** One page of matches, and how many there are in all (#266). */
export interface PickerPage {
  items: PickerOption[];
  total: number;
}

/** Matches a picker asks for at a time (#266). */
export const PICKER_PAGE_SIZE = 20;

/** A list endpoint's answer as a picker's page. */
export function pickerPage<T>(res: { items: T[]; total: number }, option: (item: T) => PickerOption): PickerPage {
  return { items: res.items.map(option), total: res.total };
}
