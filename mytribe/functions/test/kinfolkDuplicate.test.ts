import { describe, it, expect } from 'vitest';
import {
  KINFOLK_DUPLICATE_WINDOW_MS,
  duplicateEmailKey,
  duplicateMatch,
  duplicatePhoneKey,
} from '../src/lib/kinfolkDuplicate';

/**
 * #890: the one rule for "this Add is the household this operator just
 * created". The createKinfolk callable refuses a second create on it, and the
 * read-only prod report (mytribe/scripts/reportDuplicateKinfolk.ts) finds the
 * duplicates made before the callable existed.
 */
describe('kinfolkDuplicate', () => {
  it('is a ten minute window', () => {
    expect(KINFOLK_DUPLICATE_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  it('reads a phone the same however it was typed', () => {
    expect(duplicatePhoneKey('(805) 555-0134')).toBe('18055550134');
    expect(duplicatePhoneKey('+1 805 555 0134')).toBe('18055550134');
    expect(duplicatePhoneKey('8055550134')).toBe('18055550134');
  });

  it('never keys a blank or too-short phone, so two households with no phone do not match', () => {
    expect(duplicatePhoneKey('')).toBeNull();
    expect(duplicatePhoneKey('   ')).toBeNull();
    expect(duplicatePhoneKey('12')).toBeNull();
    expect(duplicatePhoneKey(undefined)).toBeNull();
    expect(duplicatePhoneKey(42)).toBeNull();
  });

  it('reads an email ignoring case and spacing, and never keys a blank one', () => {
    expect(duplicateEmailKey('  Jamie@Example.com ')).toBe('jamie@example.com');
    expect(duplicateEmailKey('')).toBeNull();
    expect(duplicateEmailKey('not an email')).toBeNull();
    expect(duplicateEmailKey(null)).toBeNull();
  });

  it('names what matched', () => {
    const a = { phoneNumber: '805-555-0134', email: 'jamie@example.com' };
    expect(duplicateMatch(a, { phoneNumber: '(805) 555-0134', email: 'other@example.com' })).toBe('phone');
    expect(duplicateMatch(a, { phoneNumber: '805-555-0199', email: 'JAMIE@example.com' })).toBe('email');
    expect(duplicateMatch(a, { phoneNumber: '8055550134', email: 'jamie@example.com' })).toBe('phone and email');
    expect(duplicateMatch(a, { phoneNumber: '805-555-0199', email: 'other@example.com' })).toBeNull();
  });

  it('does not match two households that both left phone and email blank', () => {
    expect(duplicateMatch({ phoneNumber: '', email: '' }, { phoneNumber: '', email: '' })).toBeNull();
    expect(duplicateMatch({}, {})).toBeNull();
  });
});
