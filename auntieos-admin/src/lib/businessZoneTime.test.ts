import { describe, it, expect } from 'vitest';
import { nightLabel, startTimeOnNight, wallClockInZoneToMs } from './businessZoneTime';

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
