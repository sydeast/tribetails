import { describe, expect, it } from 'vitest';
import { businessLabel } from './businessLabel';
describe('businessLabel (#1381)', () => {
  it('uses the settings name as written', () => {
    expect(businessLabel('Test Business')).toBe('Test Business');
    expect(businessLabel('  Test Business  ', { capital: true })).toBe('Test Business');
  });
  it('falls back to "your Auntie" when the name is unset, blank or absent', () => {
    expect(businessLabel(undefined)).toBe('your Auntie');
    expect(businessLabel(null)).toBe('your Auntie');
    expect(businessLabel('   ')).toBe('your Auntie');
  });
  it('capitalises only when the label opens a sentence', () => {
    expect(businessLabel('', { capital: true })).toBe('Your Auntie');
  });
  it('forms the possessive for either label', () => {
    expect(businessLabel('Test Business', { possessive: true })).toBe('Test Business’s');
    expect(businessLabel('', { possessive: true, capital: true })).toBe('Your Auntie’s');
  });
});
