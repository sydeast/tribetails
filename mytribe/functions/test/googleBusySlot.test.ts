import { describe, it, expect } from 'vitest';
import {
  busyIntervalToSlots,
  splitAtBusinessMidnight,
  zonedMidnightMs,
  busyEventKey,
  MAX_BUSY_DAY_PIECES,
} from '../src/lib/googleBusySlot';

const CHICAGO = 'America/Chicago';
const ms = (iso: string): number => Date.parse(iso);

describe('zonedMidnightMs', () => {
  it('finds business midnight on both sides of a DST change', () => {
    expect(zonedMidnightMs('2026-10-06', CHICAGO)).toBe(ms('2026-10-06T05:00:00Z')); // CDT
    expect(zonedMidnightMs('2026-11-02', CHICAGO)).toBe(ms('2026-11-02T06:00:00Z')); // CST
    expect(zonedMidnightMs('2026-11-01', CHICAGO)).toBe(ms('2026-11-01T05:00:00Z')); // the fall-back day, still CDT at 00:00
  });
});

describe('busyIntervalToSlots (#1160)', () => {
  it('stores a 14:00 to 15:00 Chicago busy event on the 14:00 business row, with its instants', () => {
    const slots = busyIntervalToSlots(
      { start: '2026-10-05T19:00:00Z', end: '2026-10-05T20:00:00Z' },
      'cal-x',
      '2026-10-01T00:00:00.000Z',
      CHICAGO,
    );
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      date: '2026-10-05',
      startTime: '14:00',
      endTime: '15:00',
      startMs: ms('2026-10-05T19:00:00Z'),
      endMs: ms('2026-10-05T20:00:00Z'),
      timeZone: CHICAGO,
      externalEventId: busyEventKey('cal-x', ms('2026-10-05T19:00:00Z'), ms('2026-10-05T20:00:00Z')),
    });
  });

  it('reads a blank or unknown zone as America/Chicago', () => {
    for (const zone of ['', 'America/Chigago']) {
      const [slot] = busyIntervalToSlots(
        { start: '2026-10-05T19:00:00Z', end: '2026-10-05T20:00:00Z' },
        'cal-x',
        'now',
        zone,
      );
      expect(slot).toMatchObject({ startTime: '14:00', timeZone: CHICAGO });
    }
  });

  it('splits an event that crosses business midnight into one row per business day', () => {
    // 22:00 CDT to 02:00 CDT. In UTC this is 03:00 to 07:00 on ONE day, so a
    // UTC split would not have caught it at all.
    const slots = busyIntervalToSlots(
      { start: '2026-10-06T03:00:00Z', end: '2026-10-06T07:00:00Z' },
      'cal-x',
      'now',
      CHICAGO,
    );
    const key = busyEventKey('cal-x', ms('2026-10-06T03:00:00Z'), ms('2026-10-06T07:00:00Z'));
    expect(slots.map((s) => [s.date, s.startTime, s.endTime, s.startMs, s.endMs, s.externalEventId])).toEqual([
      ['2026-10-05', '22:00', '23:59', ms('2026-10-06T03:00:00Z'), ms('2026-10-06T05:00:00Z'), key],
      ['2026-10-06', '00:00', '02:00', ms('2026-10-06T05:00:00Z'), ms('2026-10-06T07:00:00Z'), `${key}_d1`],
    ]);
  });

  it('an event ending exactly at business midnight is one row', () => {
    const slots = busyIntervalToSlots(
      { start: '2026-10-06T03:00:00Z', end: '2026-10-06T05:00:00Z' },
      'cal-x',
      'now',
      CHICAGO,
    );
    expect(slots.map((s) => [s.date, s.startTime, s.endTime])).toEqual([['2026-10-05', '22:00', '23:59']]);
    expect(slots[0]!.endMs).toBe(ms('2026-10-06T05:00:00Z'));
  });

  it('splits across the fall-back DST change at the real midnights', () => {
    // 2026-10-31 20:00 CDT to 2026-11-02 01:00 CST
    const pieces = splitAtBusinessMidnight(ms('2026-11-01T01:00:00Z'), ms('2026-11-02T07:00:00Z'), CHICAGO);
    expect(pieces.map((p) => [p.dateIso, p.startHHmm, p.endHHmm, p.startMs, p.endMs])).toEqual([
      ['2026-10-31', '20:00', '23:59', ms('2026-11-01T01:00:00Z'), ms('2026-11-01T05:00:00Z')],
      ['2026-11-01', '00:00', '23:59', ms('2026-11-01T05:00:00Z'), ms('2026-11-02T06:00:00Z')],
      ['2026-11-02', '00:00', '01:00', ms('2026-11-02T06:00:00Z'), ms('2026-11-02T07:00:00Z')],
    ]);
  });

  it('returns nothing for an empty or unreadable interval, and caps a runaway one', () => {
    expect(busyIntervalToSlots({ start: 'x', end: 'y' }, 'c', 'now', CHICAGO)).toEqual([]);
    expect(splitAtBusinessMidnight(10, 10, CHICAGO)).toEqual([]);
    const year = splitAtBusinessMidnight(ms('2026-01-01T12:00:00Z'), ms('2027-01-01T12:00:00Z'), CHICAGO);
    expect(year).toHaveLength(MAX_BUSY_DAY_PIECES);
  });
});
