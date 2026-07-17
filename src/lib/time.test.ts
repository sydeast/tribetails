import { describe, it, expect } from 'vitest';
import type { Timestamp } from 'firebase/firestore';
import { tsToDate, dayKey, formatWhen, machineWhen } from './time';

/** A fake Firestore Timestamp wrapping a real (local) Date. */
function ts(d: Date): Timestamp {
  return { toDate: () => d } as unknown as Timestamp;
}

describe('lib/time (local, AO-18)', () => {
  it('null/undefined timestamps degrade honestly', () => {
    expect(tsToDate(null)).toBeNull();
    expect(dayKey(null)).toBe('Undated');
    expect(formatWhen(undefined)).toBe('(no time)');
    expect(machineWhen(null)).toBeUndefined();
  });

  it('dayKey uses LOCAL date parts, not UTC', () => {
    // A local evening time. Whatever the runner's zone, the local calendar day
    // is what getFullYear/Month/Date report — and that is the day we must group by.
    const d = new Date(2026, 6, 16, 20, 5); // 2026-07-16 20:05 local
    expect(dayKey(ts(d))).toBe('2026-07-16');
  });

  it('formatWhen renders local MM-DD HH:mm', () => {
    expect(formatWhen(ts(new Date(2026, 6, 16, 9, 3)))).toBe('07-16 09:03');
    expect(formatWhen(ts(new Date(2026, 11, 1, 23, 59)))).toBe('12-01 23:59');
  });

  it('machineWhen is a local ISO-ish datetime for <time dateTime>', () => {
    expect(machineWhen(ts(new Date(2026, 6, 16, 9, 3)))).toBe('2026-07-16T09:03');
  });

  it('does NOT roll a late-evening local time into the next day (the AO-18 regression)', () => {
    // 23:30 local on the 16th must stay the 16th, not roll to the 17th as a UTC
    // slice would in any zone west of UTC.
    const late = new Date(2026, 6, 16, 23, 30);
    expect(dayKey(ts(late))).toBe('2026-07-16');
  });
});
