// #21, catalog part 2: the book form accepts an ISBN-10 as well as an
// ISBN-13 (the API stores it as its ISBN-13); it used to refuse anything but
// 13 digits.
import { describe, it, expect } from 'vitest';
import { isValidIsbn } from '../lib/isbn.js';

describe('isValidIsbn', () => {
  it('accepts a valid ISBN-13, with or without dashes', () => {
    expect(isValidIsbn('9780306406157')).toBe(true);
    expect(isValidIsbn('978-0-306-40615-7')).toBe(true);
  });

  it('accepts a valid ISBN-10, including an X check digit (was: refused)', () => {
    expect(isValidIsbn('0306406152')).toBe(true);
    expect(isValidIsbn('185326041x')).toBe(true);
  });

  it('refuses a wrong check digit or length', () => {
    expect(isValidIsbn('9780306406158')).toBe(false);
    expect(isValidIsbn('0306406153')).toBe(false);
    expect(isValidIsbn('12345')).toBe(false);
  });
});
