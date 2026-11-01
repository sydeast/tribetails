import { describe, expect, it } from 'vitest';
import { businessTime, dayKey, dayLabel } from './messageDays';
// 2026-11-01 18:00 UTC = 1:00 PM CDT... (DST ended 2026-11-01 02:00 local, so CST, UTC-6: 12:00 PM)
const NOW = Date.UTC(2026, 10, 1, 18, 0);
describe('dayLabel', () => {
  it('labels today and yesterday', () => {
    expect(dayLabel(NOW - 60_000, NOW)).toBe('Today');
    expect(dayLabel(NOW - 86_400_000, NOW)).toBe('Yesterday');
  });
  it('labels the last week by weekday', () => {
    // 2026-10-29 is a Thursday
    expect(dayLabel(Date.UTC(2026, 9, 29, 18), NOW)).toBe('Thursday');
  });
  it('uses month and day within this year, adds the year otherwise', () => {
    expect(dayLabel(Date.UTC(2026, 9, 5, 18), NOW)).toBe('October 5');
    expect(dayLabel(Date.UTC(2025, 9, 5, 18), NOW)).toBe('October 5, 2025');
  });
  it('cuts days in America/Chicago, not UTC', () => {
    // 2026-11-01 03:00 UTC is still Oct 31 evening in Chicago
    const lateOct31 = Date.UTC(2026, 10, 1, 3, 0);
    expect(dayKey(lateOct31)).toBe('2026-10-31');
    expect(dayLabel(lateOct31, NOW)).toBe('Yesterday');
  });
  it('formats clock time in the business zone', () => {
    expect(businessTime(Date.UTC(2026, 9, 5, 19, 23))).toBe('2:23 PM');
  });
});
