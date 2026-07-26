import { describe, it, expect } from 'vitest';
import { parseDollarsToCents, centsToInputDollars, parseQty, qtyToInput } from './invoiceMoneyInput';

describe('parseDollarsToCents', () => {
  it('reads a plain dollar amount', () => {
    expect(parseDollarsToCents('12.50')).toBe(1250);
    expect(parseDollarsToCents('0.05')).toBe(5);
    expect(parseDollarsToCents('100')).toBe(10000);
  });

  it('accepts a leading dollar sign, separators and whitespace, because operators paste', () => {
    expect(parseDollarsToCents('  $1,250.00 ')).toBe(125000);
    expect(parseDollarsToCents('$25')).toBe(2500);
  });

  it('returns NULL, never 0, for a blank field', () => {
    // The whole point. `Number('')` is 0, and a blank price silently billing a
    // household nothing would look completely deliberate on the finished invoice.
    expect(parseDollarsToCents('')).toBeNull();
    expect(parseDollarsToCents('   ')).toBeNull();
  });

  it('returns null for text rather than NaN', () => {
    expect(parseDollarsToCents('abc')).toBeNull();
    expect(parseDollarsToCents('12abc')).toBeNull();
    expect(parseDollarsToCents('twelve fifty')).toBeNull();
  });

  it('refuses a negative amount', () => {
    expect(parseDollarsToCents('-5.00')).toBeNull();
  });

  it('REFUSES more than two decimals rather than silently rounding a typo', () => {
    // "12.345" is a mistake, and deciding on the operator's behalf whether it
    // meant $12.34 or $12.35 is not this function's call.
    expect(parseDollarsToCents('12.345')).toBeNull();
  });

  it('reads a real zero as zero, which is a legitimate unit price', () => {
    expect(parseDollarsToCents('0')).toBe(0);
    expect(parseDollarsToCents('0.00')).toBe(0);
  });

  it('converts exactly at the values binary floating point gets wrong', () => {
    expect(parseDollarsToCents('12.55')).toBe(1255);
    expect(parseDollarsToCents('1.10')).toBe(110);
    expect(parseDollarsToCents('0.29')).toBe(29);
  });
});

describe('centsToInputDollars', () => {
  it('always renders two decimals, so appending a digit cannot misbill by 10x', () => {
    expect(centsToInputDollars(1200)).toBe('12.00');
    expect(centsToInputDollars(1250)).toBe('12.50');
    expect(centsToInputDollars(0)).toBe('0.00');
  });

  it('round-trips with the parser', () => {
    for (const cents of [0, 5, 1250, 125000, 10_000_000]) {
      expect(parseDollarsToCents(centsToInputDollars(cents))).toBe(cents);
    }
  });

  it('renders a non-finite figure as blank rather than as NaN', () => {
    expect(centsToInputDollars(Number.NaN)).toBe('');
  });
});

describe('parseQty', () => {
  it('reads whole and fractional quantities', () => {
    expect(parseQty('3')).toBe(3);
    expect(parseQty('2.5')).toBe(2.5);
  });

  it('returns null for blank, text and zero', () => {
    expect(parseQty('')).toBeNull();
    expect(parseQty('abc')).toBeNull();
    // A line billing zero units is not a line, and the server refuses it too.
    expect(parseQty('0')).toBeNull();
    expect(parseQty('-1')).toBeNull();
  });
});

describe('qtyToInput', () => {
  it('does not dress a whole quantity up as money', () => {
    expect(qtyToInput(3)).toBe('3');
    expect(qtyToInput(2.5)).toBe('2.5');
  });

  it('round-trips with the parser', () => {
    expect(parseQty(qtyToInput(2.5))).toBe(2.5);
    expect(parseQty(qtyToInput(3))).toBe(3);
  });
});
