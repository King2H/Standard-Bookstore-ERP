/**
 * Whether an ISBN typed in the book form has a valid check digit: an
 * ISBN-13, or an ISBN-10 (the API stores it as its ISBN-13, #21). Dashes and
 * spaces are ignored.
 */
export function isValidIsbn(isbn: string): boolean {
  const d = isbn.replace(/[-\s]/g, '').toUpperCase();
  if (/^\d{13}$/.test(d)) {
    return [...d].reduce((a, c, i) => a + Number(c) * (i % 2 === 0 ? 1 : 3), 0) % 10 === 0;
  }
  if (/^\d{9}[\dX]$/.test(d)) {
    return [...d].reduce((a, c, i) => a + (c === 'X' ? 10 : Number(c)) * (10 - i), 0) % 11 === 0;
  }
  return false;
}
