/**
 * Exact money arithmetic (ADR-0002, #18).
 *
 * Amounts are held as integers of 1/10,000 of the currency unit, which covers
 * every money column in the schema: numeric(14,2) amounts and numeric(14,4)
 * average costs. Values are never stored as binary floats, so 0.1 + 0.2 is 0.3.
 *
 * Rounding is half away from zero ("commercial rounding"), matching the v1
 * Math.round(x * 100) / 100 pattern for positive amounts.
 */

const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);

export type MoneyInput = Money | string | number | bigint;

/** Integer division of a by b, rounded half away from zero. */
function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError('Division by zero');
  const negative = a < 0n !== b < 0n;
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const q = (absA * 2n + absB) / (absB * 2n);
  return negative ? -q : q;
}

/** Parses a decimal string into an integer of 10^-scale units, or throws. */
function parseDecimal(text: string, scale: number): bigint {
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new RangeError(`Not a decimal amount: "${text}"`);
  const [, sign, whole, fraction = ''] = match;
  const digits = BigInt(whole + fraction);
  const units = divRound(digits * 10n ** BigInt(scale), 10n ** BigInt(fraction.length));
  return sign === '-' ? -units : units;
}

/** Converts a JavaScript number to its shortest exact decimal string. */
function numberToDecimal(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`Not a finite amount: ${value}`);
  // toString gives the shortest round-trip form (0.1 -> "0.1"). Exponent forms
  // are expanded: from 1e21 numbers are whole, below that toFixed is exact enough.
  const text = String(value);
  if (!/e/i.test(text)) return text;
  return Math.abs(value) >= 1e21 ? BigInt(value).toString() : value.toFixed(20);
}

export class Money {
  private constructor(private readonly units: bigint) {}

  static readonly ZERO = new Money(0n);

  /**
   * Accepts a numeric column value (string), a request value (number), or
   * another Money. Numbers are read by their shortest decimal form, so 19.99
   * is exactly 19.99, not the nearest binary float.
   */
  static of(value: MoneyInput): Money {
    if (value instanceof Money) return value;
    if (typeof value === 'bigint') return new Money(value * FACTOR);
    if (typeof value === 'number') return new Money(parseDecimal(numberToDecimal(value), SCALE));
    return new Money(parseDecimal(value, SCALE));
  }

  static sum(values: Iterable<MoneyInput>): Money {
    let total = 0n;
    for (const v of values) total += Money.of(v).units;
    return new Money(total);
  }

  plus(other: MoneyInput): Money {
    return new Money(this.units + Money.of(other).units);
  }

  minus(other: MoneyInput): Money {
    return new Money(this.units - Money.of(other).units);
  }

  /** Multiplies by a quantity or rate (e.g. 3, "1.5"); the result keeps 4 decimals. */
  times(factor: number | string | bigint): Money {
    const f = typeof factor === 'bigint' ? factor * FACTOR : Money.of(factor).units;
    return new Money(divRound(this.units * f, FACTOR));
  }

  /** Divides by a quantity or rate; the result keeps 4 decimals (e.g. average cost). */
  dividedBy(divisor: number | string | bigint): Money {
    const d = typeof divisor === 'bigint' ? divisor * FACTOR : Money.of(divisor).units;
    return new Money(divRound(this.units * FACTOR, d));
  }

  /** `pct` percent of this amount, e.g. Money.of(200).percent(15) is 30. */
  percent(pct: number | string): Money {
    // One rounding step, so a percentage of a 4-decimal amount isn't rounded twice.
    return new Money(divRound(this.units * Money.of(pct).units, FACTOR * 100n));
  }

  /** Rounds to `decimals` places (default 2, the currency's minor unit). */
  round(decimals = 2): Money {
    if (decimals < 0 || decimals > SCALE) throw new RangeError(`Unsupported decimals: ${decimals}`);
    const step = 10n ** BigInt(SCALE - decimals);
    return new Money(divRound(this.units, step) * step);
  }

  negate(): Money {
    return new Money(-this.units);
  }

  abs(): Money {
    return this.units < 0n ? this.negate() : this;
  }

  compare(other: MoneyInput): -1 | 0 | 1 {
    const o = Money.of(other).units;
    return this.units < o ? -1 : this.units > o ? 1 : 0;
  }

  equals(other: MoneyInput): boolean {
    return this.compare(other) === 0;
  }

  greaterThan(other: MoneyInput): boolean {
    return this.compare(other) > 0;
  }

  lessThan(other: MoneyInput): boolean {
    return this.compare(other) < 0;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  static min(a: MoneyInput, b: MoneyInput): Money {
    return Money.of(a).lessThan(b) ? Money.of(a) : Money.of(b);
  }

  static max(a: MoneyInput, b: MoneyInput): Money {
    return Money.of(a).greaterThan(b) ? Money.of(a) : Money.of(b);
  }

  /**
   * Decimal string rounded to `decimals` places, e.g. "1234.50". Use it for SQL
   * parameters, so numeric columns receive exact values.
   */
  toFixed(decimals = 2): string {
    const units = this.round(decimals).units;
    const negative = units < 0n;
    const digits = (negative ? -units : units).toString().padStart(SCALE + 1, '0');
    const whole = digits.slice(0, -SCALE);
    const fraction = digits.slice(-SCALE, digits.length - (SCALE - decimals));
    return `${negative ? '-' : ''}${whole}${decimals > 0 ? `.${fraction}` : ''}`;
  }

  /** Number rounded to `decimals` places, for JSON responses that expect numbers. */
  toNumber(decimals = 2): number {
    return Number(this.toFixed(decimals));
  }

  toString(): string {
    return this.toFixed(2);
  }

  toJSON(): string {
    return this.toFixed(2);
  }
}
