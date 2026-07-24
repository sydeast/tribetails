import { describe, it, expect } from 'vitest';
import { isIsoDate, joinDateForEdit, formatJoinDate } from './joinDate';

describe('isIsoDate', () => {
  it('accepts a real YYYY-MM-DD day', () => {
    expect(isIsoDate('2026-07-24')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
  });

  it('rejects anything that is not exactly a calendar day', () => {
    expect(isIsoDate('')).toBe(false);
    expect(isIsoDate('07/24/2026')).toBe(false);
    expect(isIsoDate('2026-7-4')).toBe(false);
    expect(isIsoDate('2026-07-24T12:00:00.000Z')).toBe(false);
  });

  it('rejects a well shaped day that does not exist', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
  });
});

describe('joinDateForEdit', () => {
  it('passes an ISO day straight through with nothing to explain', () => {
    expect(joinDateForEdit('2026-07-24')).toEqual({ value: '2026-07-24', note: null });
  });

  it('treats blank as blank', () => {
    expect(joinDateForEdit('')).toEqual({ value: '', note: null });
    expect(joinDateForEdit('   ')).toEqual({ value: '', note: null });
  });

  it('reads the date out of a stored UTC timestamp and says the time will be dropped', () => {
    const got = joinDateForEdit('2026-07-24T12:34:56.789Z');
    expect(got.value).toBe('2026-07-24');
    expect(got.note).toContain('2026-07-24T12:34:56.789Z');
  });

  it('refuses to guess at an ambiguous legacy format, and names it instead', () => {
    const got = joinDateForEdit('07/24/2026');
    expect(got.value).toBe('');
    expect(got.note).toContain('07/24/2026');
  });
});

describe('formatJoinDate', () => {
  it('renders an ISO day in the medium style for the given locale', () => {
    expect(formatJoinDate('2026-07-24', 'en-US')).toBe('Jul 24, 2026');
  });

  it('reads the day off a stored UTC timestamp rather than showing it raw', () => {
    expect(formatJoinDate('2026-07-24T12:34:56.789Z', 'en-US')).toBe('Jul 24, 2026');
  });

  it('does not shift the day across a timezone boundary', () => {
    // Parsed as a LOCAL day, not as UTC midnight: `new Date('2026-01-01')` is
    // midnight UTC, which renders as Dec 31 for every operator west of Greenwich.
    expect(formatJoinDate('2026-01-01', 'en-US')).toBe('Jan 1, 2026');
  });

  it('passes a legacy value it cannot read through untouched, never "Invalid Date"', () => {
    expect(formatJoinDate('07/24/2026', 'en-US')).toBe('07/24/2026');
    expect(formatJoinDate('sometime in the spring', 'en-US')).toBe('sometime in the spring');
    expect(formatJoinDate('2026-02-30', 'en-US')).toBe('2026-02-30');
  });

  it('never throws on junk', () => {
    expect(() => formatJoinDate('!!!', 'en-US')).not.toThrow();
    expect(formatJoinDate('', 'en-US')).toBe('');
  });
});
