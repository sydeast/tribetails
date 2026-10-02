import { describe, it, expect } from 'vitest';
import {
  businessInstantMs,
  businessTodayIso,
  businessWallClock,
  businessWallClockToMs,
  nightLabel,
  sessionsByBusinessDay,
  startTimeOnNight,
  wallClockInZoneToMs,
} from './businessZoneTime';

describe('wallClockInZoneToMs (#1098)', () => {
  it('reads a wall clock in the named zone, not the runtime zone', () => {
    // 7:30 PM on Oct 9 in Chicago (CDT, UTC-5) is 00:30 UTC on Oct 10.
    expect(wallClockInZoneToMs('2026-10-09', '19:30', 'America/Chicago')).toBe(
      Date.UTC(2026, 9, 10, 0, 30),
    );
    // Same wall clock in Tokyo (UTC+9, no DST) is 10:30 UTC the same day.
    expect(wallClockInZoneToMs('2026-10-09', '19:30', 'Asia/Tokyo')).toBe(
      Date.UTC(2026, 9, 9, 10, 30),
    );
  });

  it('follows the zone across a DST change', () => {
    // Chicago is on CST (UTC-6) by December.
    expect(wallClockInZoneToMs('2026-12-04', '21:00', 'America/Chicago')).toBe(
      Date.UTC(2026, 11, 5, 3, 0),
    );
  });

  it('returns null for an unusable zone or unreadable input', () => {
    expect(wallClockInZoneToMs('2026-10-09', '19:30', '')).toBeNull();
    expect(wallClockInZoneToMs('2026-10-09', '19:30', 'Not/AZone')).toBeNull();
    expect(wallClockInZoneToMs('2026-13-09', '19:30', 'America/Chicago')).toBeNull();
    expect(wallClockInZoneToMs('2026-10-09', '25:00', 'America/Chicago')).toBeNull();
    expect(wallClockInZoneToMs('2026-10-09', '', 'America/Chicago')).toBeNull();
  });
});

describe('businessWallClock (#1150)', () => {
  it('reads an instant on the business clock, the inverse of businessWallClockToMs', () => {
    const ms = businessWallClockToMs('2026-08-03', '09:00', 'America/Chicago');
    expect(ms).toBe(Date.UTC(2026, 7, 3, 14, 0));
    expect(businessWallClock(ms!, 'America/Chicago')).toEqual({ dateIso: '2026-08-03', hhmm: '09:00' });
  });

  it('puts a late instant on the business day, not the UTC one', () => {
    // 01:30 UTC on Aug 4 is 20:30 on Aug 3 in Chicago.
    expect(businessWallClock(Date.UTC(2026, 7, 4, 1, 30), 'America/Chicago')).toEqual({
      dateIso: '2026-08-03',
      hhmm: '20:30',
    });
  });

  it('reads a blank or unusable zone as America/Chicago (#1109)', () => {
    const ms = Date.UTC(2026, 7, 3, 14, 0);
    expect(businessWallClock(ms, '').hhmm).toBe('09:00');
    expect(businessWallClock(ms, 'Mars/Olympus_Mons').hhmm).toBe('09:00');
  });

  it('gives today on the business calendar', () => {
    // 03:00 UTC Aug 4 is still Aug 3 in Chicago.
    expect(businessTodayIso('America/Chicago', Date.UTC(2026, 7, 4, 3, 0))).toBe('2026-08-03');
  });
});

describe('sessionsByBusinessDay (#1150)', () => {
  it('groups an instant by the business day and a bare wall clock by its own date', () => {
    const rows = [
      { id: 'a', startTime: '2026-08-04T01:30:00.000Z' }, // Aug 3, 20:30 Chicago
      { id: 'b', startTime: '2026-08-04T09:00:00' }, // bare: the business's Aug 4
      { id: 'c', startTime: 'not a time' },
      { id: 'd' },
    ];
    const byDay = sessionsByBusinessDay(rows, 'America/Chicago');
    expect([...byDay.keys()].sort()).toEqual(['2026-08-03', '2026-08-04']);
    expect(byDay.get('2026-08-03')!.map((r) => r.id)).toEqual(['a']);
    expect(byDay.get('2026-08-04')!.map((r) => r.id)).toEqual(['b']);
  });
});

describe('businessInstantMs (#1158)', () => {
  const zone = 'America/Chicago';

  it('reads a value with a zone as that instant', () => {
    expect(businessInstantMs('2026-10-05T19:00:00.000Z', zone)).toBe(Date.UTC(2026, 9, 5, 19, 0));
    expect(businessInstantMs('2026-10-05T14:00:00-05:00', zone)).toBe(Date.UTC(2026, 9, 5, 19, 0));
  });

  it('reads a zone-less value as the business wall clock, keeping seconds', () => {
    expect(businessInstantMs('2026-10-05T14:00', zone)).toBe(Date.UTC(2026, 9, 5, 19, 0));
    expect(businessInstantMs('2026-10-05T14:00:30', zone)).toBe(Date.UTC(2026, 9, 5, 19, 0, 30));
    expect(businessInstantMs('2026-10-05T14:00:30.250', zone)).toBe(Date.UTC(2026, 9, 5, 19, 0, 30, 250));
  });

  it('reads a date alone as the business midnight', () => {
    expect(businessInstantMs('2026-10-05', zone)).toBe(Date.UTC(2026, 9, 5, 5, 0));
  });

  it('returns null for a blank, unreadable or impossible value', () => {
    expect(businessInstantMs('', zone)).toBeNull();
    expect(businessInstantMs('sometime', zone)).toBeNull();
    expect(businessInstantMs('2026-02-30T09:00', zone)).toBeNull();
  });
});

describe('startTimeOnNight', () => {
  it('uses the business zone when it is usable', () => {
    expect(startTimeOnNight('2026-10-09', '19:30', 'America/Chicago')).toBe(
      Date.UTC(2026, 9, 10, 0, 30),
    );
  });

  it('falls back to the server default, America/Chicago, when the business zone is missing or unusable (#1109)', () => {
    const chicago = Date.UTC(2026, 9, 10, 0, 30);
    expect(startTimeOnNight('2026-10-09', '19:30', '')).toBe(chicago);
    expect(startTimeOnNight('2026-10-09', '19:30', 'Mars/Olympus_Mons')).toBe(chicago);
  });
});

describe('nightLabel', () => {
  it('names the night as the date the household asked for, whatever the runtime zone', () => {
    expect(nightLabel('2026-10-09')).toBe('Fri, Oct 9');
  });

  it('passes an unreadable value through rather than inventing a date', () => {
    expect(nightLabel('soon')).toBe('soon');
  });
});
