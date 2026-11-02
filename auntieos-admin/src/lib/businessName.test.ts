import { describe, it, expect } from 'vitest';
import { BUSINESS_NAME_REQUIRED_MESSAGE, businessNameError, isValidBusinessName } from './businessName';

/**
 * #1409: the same cases the rules suite pins on `bsNonBlankString` and the
 * Android and desktop `BusinessNameTest`s pin on their copies. A value that
 * passes here must pass there, or the operator sees Save light up and the
 * write refused.
 */
describe('isValidBusinessName (#1409)', () => {
  it('accepts any name with at least one non-space character', () => {
    expect(isValidBusinessName('Sunny Paws')).toBe(true);
    expect(isValidBusinessName('S')).toBe(true);
    expect(isValidBusinessName('  Sunny Paws  ')).toBe(true);
  });

  it('refuses blank and whitespace', () => {
    expect(isValidBusinessName('')).toBe(false);
    expect(isValidBusinessName(' ')).toBe(false);
    expect(isValidBusinessName('   ')).toBe(false);
    expect(isValidBusinessName('\t\n')).toBe(false);
  });
});

describe('businessNameError (#1409)', () => {
  it('says nothing for a name, with or without padding', () => {
    expect(businessNameError('Sunny Paws')).toBeNull();
    expect(businessNameError('  Sunny Paws  ')).toBeNull();
  });

  it('asks for the name for blank or whitespace', () => {
    expect(BUSINESS_NAME_REQUIRED_MESSAGE).toBe('Enter the business name.');
    expect(businessNameError('')).toBe('Enter the business name.');
    expect(businessNameError('   ')).toBe('Enter the business name.');
  });
});
