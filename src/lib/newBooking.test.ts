import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  localDateTimeToMs,
  expandWeekly,
  visitMsFromRows,
  allInFuture,
} from './newBooking';

// AO-18: this math is LOCAL-time; pin the zone so the assertions are stable.
const ORIG_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  process.env.TZ = ORIG_TZ;
});

describe('localDateTimeToMs', () => {
  it('parses a datetime-local string as local time', () => {
    const ms = localDateTimeToMs('2026-08-03T09:00');
    expect(ms).not.toBeNull();
    const d = new Date(ms!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // August, 0-based
    expect(d.getDate()).toBe(3);
    expect(d.getHours()).toBe(9);
  });
  it('returns null for blank or garbage', () => {
    expect(localDateTimeToMs('')).toBeNull();
    expect(localDateTimeToMs('   ')).toBeNull();
    expect(localDateTimeToMs('not-a-date')).toBeNull();
  });
});

describe('expandWeekly', () => {
  it('produces one occurrence per selected weekday per week, each on the right weekday', () => {
    // 2026-08-03 is a Monday. Ask for Mon(1) + Wed(3), 2 weeks.
    const ms = expandWeekly({ startDateIso: '2026-08-03', time: '09:00', weeklyDays: [1, 3], weeks: 2 });
    expect(ms).toHaveLength(4);
    for (const m of ms) {
      const d = new Date(m);
      expect([1, 3]).toContain(d.getDay());
      expect(d.getHours()).toBe(9);
    }
    // ascending
    expect([...ms].sort((a, b) => a - b)).toEqual(ms);
  });
  it('is empty when no weekday is selected or weeks < 1', () => {
    expect(expandWeekly({ startDateIso: '2026-08-03', time: '09:00', weeklyDays: [], weeks: 2 })).toEqual([]);
    expect(expandWeekly({ startDateIso: '2026-08-03', time: '09:00', weeklyDays: [1], weeks: 0 })).toEqual([]);
  });
  it('is empty for a blank date or time', () => {
    expect(expandWeekly({ startDateIso: '', time: '09:00', weeklyDays: [1], weeks: 1 })).toEqual([]);
    expect(expandWeekly({ startDateIso: '2026-08-03', time: '', weeklyDays: [1], weeks: 1 })).toEqual([]);
  });
});

describe('visitMsFromRows', () => {
  it('drops blank/invalid rows and de-dupes, ascending', () => {
    const ms = visitMsFromRows([
      { dateTimeLocal: '2026-08-10T09:00' },
      { dateTimeLocal: '' },
      { dateTimeLocal: '2026-08-03T09:00' },
      { dateTimeLocal: '2026-08-03T09:00' }, // dup
    ]);
    expect(ms).toHaveLength(2);
    expect(ms[0]).toBeLessThan(ms[1]!);
  });
});

describe('allInFuture', () => {
  it('is true when every start is at/after now (minus a 1-min grace)', () => {
    const now = 1_000_000_000_000;
    expect(allInFuture([now + 1000, now + 5000], now)).toBe(true);
    expect(allInFuture([now - 30_000], now)).toBe(true); // within grace
  });
  it('is false when any start is safely in the past', () => {
    const now = 1_000_000_000_000;
    expect(allInFuture([now + 5000, now - 120_000], now)).toBe(false);
  });
});
