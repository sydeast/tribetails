import { describe, expect, it } from 'vitest';
import { addressLooksIncomplete } from './addressCompleteness';

/** #1602: "18605" reached the visit and the Auntie Time chip with no hint. */
describe('addressLooksIncomplete (#1602)', () => {
  it('flags a bare number or ZIP', () => {
    expect(addressLooksIncomplete('18605')).toBe(true);
    expect(addressLooksIncomplete('  78701 ')).toBe(true);
  });

  it('flags a street with no number and no town', () => {
    expect(addressLooksIncomplete('Main St')).toBe(true);
  });

  it('accepts a street with a town', () => {
    expect(addressLooksIncomplete('18605 Oak Lane, Austin TX')).toBe(false);
    expect(addressLooksIncomplete('12 Rue Cler, Paris')).toBe(false);
    expect(addressLooksIncomplete('18605 Oak Lane Austin')).toBe(false);
  });

  it('says nothing about a blank address, which the screens already omit', () => {
    expect(addressLooksIncomplete('   ')).toBe(false);
  });
});
