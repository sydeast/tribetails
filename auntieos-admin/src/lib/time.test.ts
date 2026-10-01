import { describe, it, expect } from 'vitest';
import type { Timestamp } from 'firebase/firestore';
import { tsToDate, dayKey, formatWhen, formatWhenFull, machineWhen } from './time';

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
    // is what getFullYear/Month/Date report, and that is the day we must group by.
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

  it('formatWhenFull renders local YYYY-MM-DD HH:mm, with the year', () => {
    expect(formatWhenFull(ts(new Date(2026, 6, 16, 9, 3)))).toBe('2026-07-16 09:03');
    expect(formatWhenFull(ts(new Date(2026, 11, 1, 23, 59)))).toBe('2026-12-01 23:59');
  });

  it('formatWhenFull is null for a missing timestamp, not a placeholder string', () => {
    expect(formatWhenFull(null)).toBeNull();
    expect(formatWhenFull(undefined)).toBeNull();
  });

  // #1065: the server writes notifications.createdAt as a Timestamp, but a row
  // can still carry an ISO string, epoch millis or a Date (hand-seeded, imported,
  // or a future writer). `ts.toDate()` on a string threw inside render and the
  // error boundary blanked the whole Notifications page.
  it('reads an ISO string, epoch millis and a Date as the same instant as a Timestamp', () => {
    const d = new Date(2026, 6, 16, 9, 3);
    expect(formatWhen(d.toISOString())).toBe('07-16 09:03');
    expect(formatWhen(d.getTime())).toBe('07-16 09:03');
    expect(formatWhen(d)).toBe('07-16 09:03');
    expect(dayKey(d.toISOString())).toBe('2026-07-16');
    expect(machineWhen(d.getTime())).toBe('2026-07-16T09:03');
    expect(formatWhenFull(d)).toBe('2026-07-16 09:03');
    expect(tsToDate(d.toISOString())?.getTime()).toBe(d.getTime());
  });

  it('a malformed value degrades to "no time" instead of throwing', () => {
    for (const bad of ['', '   ', 'not a date', Number.NaN, { seconds: 'x' }, true, new Date('nope')]) {
      expect(() => formatWhen(bad as never)).not.toThrow();
      expect(tsToDate(bad as never)).toBeNull();
      expect(formatWhen(bad as never)).toBe('(no time)');
      expect(dayKey(bad as never)).toBe('Undated');
    }
  });

  it('a Timestamp-like whose toDate throws or returns an invalid Date is "no time"', () => {
    const broken = { toDate: () => { throw new Error('boom'); } } as unknown as Timestamp;
    const invalid = { toDate: () => new Date('nope') } as unknown as Timestamp;
    expect(tsToDate(broken)).toBeNull();
    expect(tsToDate(invalid)).toBeNull();
  });

  it('does NOT roll a late-evening local time into the next day (the AO-18 regression)', () => {
    // 23:30 local on the 16th must stay the 16th, not roll to the 17th as a UTC
    // slice would in any zone west of UTC.
    const late = new Date(2026, 6, 16, 23, 30);
    expect(dayKey(ts(late))).toBe('2026-07-16');
  });
});
