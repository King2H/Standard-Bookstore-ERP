import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';

describe('Money', () => {
  describe('parsing', () => {
    it('reads numeric column strings exactly', () => {
      expect(Money.of('1234.50').toFixed()).toBe('1234.50');
      expect(Money.of('0.0001').toFixed(4)).toBe('0.0001');
      expect(Money.of('-12.3').toFixed()).toBe('-12.30');
    });

    it('reads numbers by their decimal form, not the binary float', () => {
      expect(Money.of(19.99).toFixed()).toBe('19.99');
      expect(Money.of(0.1).plus(0.2).equals('0.3')).toBe(true);
      expect(Money.of(1e21).toFixed(0)).toBe('1000000000000000000000');
      expect(Money.of(1e-7).isZero()).toBe(true);
    });

    it('rejects values that are not amounts', () => {
      for (const bad of ['', 'abc', '1,000.00', '1.2.3', 'NaN']) {
        expect(() => Money.of(bad)).toThrow(RangeError);
      }
      expect(() => Money.of(Number.NaN)).toThrow(RangeError);
      expect(() => Money.of(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });
  });

  describe('arithmetic', () => {
    it('adds and subtracts without float drift', () => {
      expect(Money.sum(['0.10', '0.20', 0.3]).toFixed()).toBe('0.60');
      expect(Money.of('100.00').minus('99.99').toFixed()).toBe('0.01');
    });

    it('multiplies by quantities and rates', () => {
      expect(Money.of('19.99').times(3).toFixed()).toBe('59.97');
      expect(Money.of('10.00').times('1.5').toFixed()).toBe('15.00');
      expect(Money.of('1.11').times(3n).toFixed()).toBe('3.33');
    });

    it('divides with 4-decimal precision for average costs', () => {
      expect(Money.of('100.00').dividedBy(3).toFixed(4)).toBe('33.3333');
      expect(Money.of('200.00').dividedBy(3).toFixed(4)).toBe('66.6667');
      expect(() => Money.of(1).dividedBy(0)).toThrow(RangeError);
    });

    it('takes percentages', () => {
      expect(Money.of('200.00').percent(15).toFixed()).toBe('30.00');
      expect(Money.of('33.33').percent('12.5').toFixed()).toBe('4.17');
    });
  });

  describe('rounding', () => {
    it('rounds half away from zero', () => {
      expect(Money.of('2.345').toFixed()).toBe('2.35');
      expect(Money.of('2.344').toFixed()).toBe('2.34');
      expect(Money.of('-2.345').toFixed()).toBe('-2.35');
      expect(Money.of('0.125').round(2).toFixed(4)).toBe('0.1300');
    });

    it('matches the v1 Math.round(x * 100) / 100 pattern on positive amounts', () => {
      // 1.005 is stored as 1.00499999… in binary, so Math.round gives 1.00;
      // Money reads the decimal 1.005 and gives the commercially correct 1.01.
      for (const [price, qty] of [[19.99, 3], [12.5, 7], [0.33, 3], [149.95, 2]] as const) {
        expect(Money.of(price).times(qty).toNumber()).toBe(Math.round(price * qty * 100) / 100);
      }
      expect(Money.of(1.005).toFixed()).toBe('1.01');
    });

    it('supports 0 to 4 decimals only', () => {
      expect(Money.of('12.5').toFixed(0)).toBe('13');
      expect(() => Money.of(1).round(5)).toThrow(RangeError);
    });
  });

  describe('comparison and output', () => {
    it('compares exactly', () => {
      const a = Money.of('10.00');
      expect(a.equals(10)).toBe(true);
      expect(a.greaterThan('9.99')).toBe(true);
      expect(a.lessThan('10.0001')).toBe(true);
      expect(Money.min('5', '4.99').toFixed()).toBe('4.99');
      expect(Money.max('5', '4.99').toFixed()).toBe('5.00');
      expect(Money.of('-1').isNegative()).toBe(true);
      expect(Money.of('-1').abs().toFixed()).toBe('1.00');
    });

    it('serialises as exact strings, and as numbers on request', () => {
      expect(JSON.stringify({ total: Money.of('1234.5') })).toBe('{"total":"1234.50"}');
      expect(Money.of('1234.5').toNumber()).toBe(1234.5);
      expect(String(Money.of(3))).toBe('3.00');
    });
  });
});
