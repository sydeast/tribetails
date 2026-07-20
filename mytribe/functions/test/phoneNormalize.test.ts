import { describe, it, expect } from 'vitest';
import { normalizeE164, isValidPhone } from '../src/lib/phoneNormalize';

describe('normalizeE164', () => {
  it('returns null for null/empty', () => {
    expect(normalizeE164(null)).toBeNull();
    expect(normalizeE164(undefined)).toBeNull();
    expect(normalizeE164('')).toBeNull();
    expect(normalizeE164('   ')).toBeNull();
  });

  it('converts US-formatted numbers to E.164', () => {
    expect(normalizeE164('(415) 555-2671')).toBe('+14155552671');
    expect(normalizeE164('415-555-2671')).toBe('+14155552671');
    expect(normalizeE164('4155552671')).toBe('+14155552671');
  });

  it('passes through already-E.164 numbers', () => {
    expect(normalizeE164('+14155552671')).toBe('+14155552671');
  });

  it('uses defaultCountry when supplied', () => {
    expect(normalizeE164('020 7946 0958', 'GB')).toBe('+442079460958');
  });

  it('throws on invalid input (fail-loud)', () => {
    expect(() => normalizeE164('abc')).toThrow(/not a valid phone number/);
    expect(() => normalizeE164('12345')).toThrow(/not a valid phone number/);
  });
});

describe('isValidPhone', () => {
  it('returns true for valid', () => {
    expect(isValidPhone('+14155552671')).toBe(true);
    expect(isValidPhone('(415) 555-2671')).toBe(true);
  });

  it('returns false for invalid', () => {
    expect(isValidPhone('abc')).toBe(false);
    expect(isValidPhone('1')).toBe(false);
  });
});
