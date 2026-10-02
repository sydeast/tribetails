import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GRID_END_MINUTE,
  GRID_START_MINUTE,
  HOUR_HEIGHT_PX,
  MIN_BLOCK_MINUTES,
  SNAP_MINUTES_OFF,
  SNAP_MINUTES_ON,
  busyPlacement,
  clampDropMinute,
  gridPlacement,
  hhmmFromMinutes,
  hourLabel,
  isNoOpDrop,
  businessDayOf,
  businessMinutesNow,
  businessMinutesOfDay,
  businessWindowLabel,
  minuteFromOffsetPx,
  minutesFromHHmm,
  dropMinuteFromOffsetPx,
  rescheduleTimesForDrop,
  snapMinuteOfDay,
} from './scheduleGrid';
import { businessWallClockToMs } from './businessZoneTime';

/**
 * The drop math for #397 M13, stated outright rather than inferred from a
 * pointer gesture.
 *
 * #1158: the DEVICE is pinned to America/Los_Angeles and the BUSINESS is
 * America/Chicago, two hours apart, so a grid drawn or a drop built on the
 * device clock fails here. Expected instants are the business wall clock.
 */
const BIZ = 'America/Chicago';
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});
const pad = (n: number) => String(n).padStart(2, '0');
const bizIso = (y: number, m: number, d: number, hh: number, mm: number) =>
  new Date(businessWallClockToMs(`${y}-${pad(m)}-${pad(d)}`, `${pad(hh)}:${pad(mm)}`, BIZ)!).toISOString();

describe('clock helpers', () => {
  it('reads a minute-of-day off an instant on the business clock, not the device', () => {
    // 19:00Z is 14:00 in Chicago (CDT) and 12:00 on the LA device.
    expect(businessMinutesOfDay('2026-10-05T19:00:00.000Z', BIZ)).toBe(14 * 60);
  });

  it('reads a zone-less start as the business wall clock it already is', () => {
    expect(businessMinutesOfDay('2026-10-05T14:00:00', BIZ)).toBe(14 * 60);
  });

  it('puts a visit on its business day, even when the device is still on the day before', () => {
    // 05:30Z on Oct 6 is 00:30 Oct 6 in Chicago and 22:30 Oct 5 in LA.
    expect(businessDayOf('2026-10-06T05:30:00.000Z', BIZ)).toBe('2026-10-06');
    expect(businessDayOf('2026-10-05T23:30:00', BIZ)).toBe('2026-10-05');
    expect(businessDayOf('whenever', BIZ)).toBeNull();
  });

  it('reads now on the business clock', () => {
    expect(businessMinutesNow(BIZ, Date.UTC(2026, 9, 5, 16, 18))).toBe(11 * 60 + 18);
  });

  it('labels the agenda window on the business clock', () => {
    expect(businessWindowLabel('2026-10-05T19:00:00.000Z', '2026-10-05T20:30:00.000Z', BIZ)).toBe('14:00 to 15:30');
    expect(businessWindowLabel('2026-10-05T19:00:00.000Z', '', BIZ)).toBe('14:00');
    expect(businessWindowLabel('', '2026-10-05T20:30:00.000Z', BIZ)).toBe('15:30');
    expect(businessWindowLabel('', '', BIZ)).toBe('Time TBD');
  });

  it('is null rather than zero for anything unreadable', () => {
    expect(businessMinutesOfDay('', BIZ)).toBeNull();
    expect(businessMinutesOfDay('sometime tuesday', BIZ)).toBeNull();
    expect(businessMinutesOfDay(undefined, BIZ)).toBeNull();
  });

  it('parses the plain HH:mm a busy row stores, and refuses anything else', () => {
    expect(minutesFromHHmm('09:30')).toBe(570);
    expect(minutesFromHHmm('9:30')).toBeNull();
    expect(minutesFromHHmm('24:00')).toBeNull();
    expect(minutesFromHHmm(undefined)).toBeNull();
  });

  it('formats a minute-of-day, clamped into a real clock rather than rolling over', () => {
    expect(hhmmFromMinutes(0)).toBe('00:00');
    expect(hhmmFromMinutes(9 * 60 + 5)).toBe('09:05');
    expect(hhmmFromMinutes(2000)).toBe('23:59');
  });

  it('labels the gutter the way the mock does', () => {
    expect(hourLabel(8)).toBe('8a');
    expect(hourLabel(12)).toBe('12p');
    expect(hourLabel(13)).toBe('1p');
    expect(hourLabel(18)).toBe('6p');
  });
});

describe('gridPlacement', () => {
  it('puts the first drawn hour at the top of the column', () => {
    expect(gridPlacement(GRID_START_MINUTE, 60)).toEqual({ topPx: 0, heightPx: HOUR_HEIGHT_PX });
  });

  it('is 0.9px a minute, matching the desktop grid', () => {
    const place = gridPlacement(GRID_START_MINUTE + 90, 30);
    expect(place?.topPx).toBeCloseTo(HOUR_HEIGHT_PX * 1.5);
    expect(place?.heightPx).toBeCloseTo(HOUR_HEIGHT_PX * 0.5);
  });

  it('draws a sliver of a visit at a legible minimum instead of a few pixels', () => {
    const place = gridPlacement(GRID_START_MINUTE, 5);
    expect(place?.heightPx).toBeCloseTo((HOUR_HEIGHT_PX * MIN_BLOCK_MINUTES) / 60);
  });

  it('never draws past the bottom edge, even for a long visit near it', () => {
    const place = gridPlacement(GRID_END_MINUTE - 10, 180);
    expect(place?.heightPx).toBeCloseTo((HOUR_HEIGHT_PX * 10) / 60);
  });

  it('refuses a start outside the drawn window rather than clamping it into a lie', () => {
    expect(gridPlacement(GRID_START_MINUTE - 1, 60)).toBeNull();
    expect(gridPlacement(GRID_END_MINUTE, 60)).toBeNull();
    expect(gridPlacement(Number.NaN, 60)).toBeNull();
  });

  it('places a busy overlay from its two wall-clock strings', () => {
    expect(busyPlacement('09:00', '10:00')).toEqual({
      topPx: HOUR_HEIGHT_PX,
      heightPx: HOUR_HEIGHT_PX,
    });
    expect(busyPlacement('nope', '10:00')).toBeNull();
  });
  it('clamps a busy block that starts before or ends after the window into view', () => {
    // 07:00 to 10:00 shows as 08:00 to 10:00.
    expect(busyPlacement('07:00', '10:00')).toEqual({ topPx: 0, heightPx: 2 * HOUR_HEIGHT_PX });
    // 17:00 to 20:00 shows as 17:00 to 18:00.
    expect(busyPlacement('17:00', '20:00')).toEqual({
      topPx: 9 * HOUR_HEIGHT_PX,
      heightPx: HOUR_HEIGHT_PX,
    });
    // Wholly outside still has nowhere to go.
    expect(busyPlacement('05:00', '07:00')).toBeNull();
    expect(busyPlacement('18:00', '19:00')).toBeNull();
  });
});

describe('drop math', () => {
  it('turns a vertical offset back into a minute-of-day', () => {
    expect(minuteFromOffsetPx(0)).toBe(GRID_START_MINUTE);
    expect(minuteFromOffsetPx(HOUR_HEIGHT_PX)).toBe(GRID_START_MINUTE + 60);
  });

  it('snaps DOWN, the way rescheduleArgsForDrop does on the other two clients', () => {
    expect(snapMinuteOfDay(9 * 60 + 7, SNAP_MINUTES_ON)).toBe(9 * 60);
    expect(snapMinuteOfDay(9 * 60 + 14, SNAP_MINUTES_ON)).toBe(9 * 60);
    expect(snapMinuteOfDay(9 * 60 + 15, SNAP_MINUTES_ON)).toBe(9 * 60 + 15);
  });

  it('snaps to the minute when the operator has the 15-min setting off', () => {
    expect(snapMinuteOfDay(9 * 60 + 7, SNAP_MINUTES_OFF)).toBe(9 * 60 + 7);
  });

  it('holds a drop inside the drawn window', () => {
    expect(clampDropMinute(0)).toBe(GRID_START_MINUTE);
    expect(clampDropMinute(GRID_END_MINUTE + 120)).toBe(GRID_END_MINUTE - 1);
  });

  /**
   * Clamp before snap, never after: snapping 18:05 first gives 18:00, the
   * exclusive bottom edge, which is not a drawable minute at all.
   */
  it('a drop below the grid lands on the last snappable minute inside it', () => {
    expect(dropMinuteFromOffsetPx(10_000, SNAP_MINUTES_ON)).toBe(17 * 60 + 45);
  });
});

describe('rescheduleTimesForDrop', () => {
  const visit = {
    _id: 'sess-1',
    startTime: bizIso(2026, 7, 16, 9, 0),
    endTime: bizIso(2026, 7, 16, 10, 30),
  };

  it('starts where the pointer dropped, snapped, and ENDS from the stored span', () => {
    const times = rescheduleTimesForDrop(visit, '2026-07-17', 13 * 60 + 7, SNAP_MINUTES_ON, BIZ);
    expect(times).toEqual({
      startTime: bizIso(2026, 7, 17, 13, 0),
      // 90 minutes: the visit's own 9:00-10:30 span, NOT anything about the drop.
      endTime: bizIso(2026, 7, 17, 14, 30),
    });
  });

  it('prefers the stated serviceDurationMinutes over the start-to-end span', () => {
    const times = rescheduleTimesForDrop(
      { ...visit, serviceDurationMinutes: 45 },
      '2026-07-16',
      11 * 60,
      SNAP_MINUTES_ON,
      BIZ,
    );
    expect(times).toEqual({
      startTime: bizIso(2026, 7, 16, 11, 0),
      endTime: bizIso(2026, 7, 16, 11, 45),
    });
  });

  it('falls back to 30 minutes when the row states no length at all', () => {
    const times = rescheduleTimesForDrop({ _id: 'sess-2' }, '2026-07-16', 11 * 60, SNAP_MINUTES_ON, BIZ);
    expect(times).toEqual({
      startTime: bizIso(2026, 7, 16, 11, 0),
      endTime: bizIso(2026, 7, 16, 11, 30),
    });
  });

  it('moving to another DAY keeps the visit exactly as long', () => {
    const times = rescheduleTimesForDrop(visit, '2026-07-20', 8 * 60, SNAP_MINUTES_ON, BIZ);
    expect(times).toEqual({
      startTime: bizIso(2026, 7, 20, 8, 0),
      endTime: bizIso(2026, 7, 20, 9, 30),
    });
  });

  it('a drop on the 15:00 row sends 15:00 on the business clock, not the device (#1158)', () => {
    const times = rescheduleTimesForDrop({ _id: 'sess-3', serviceDurationMinutes: 60 }, '2026-10-05', 15 * 60, 1, BIZ);
    // 15:00 in Chicago (CDT) is 20:00Z. Built on the LA device it would be 22:00Z.
    expect(times).toEqual({ startTime: '2026-10-05T20:00:00.000Z', endTime: '2026-10-05T21:00:00.000Z' });
  });

  it('is null, never a guessed window, for a blank id or an impossible day', () => {
    expect(rescheduleTimesForDrop({ ...visit, _id: '  ' }, '2026-07-16', 600, 15, BIZ)).toBeNull();
    expect(rescheduleTimesForDrop(visit, '2026-02-30', 600, 15, BIZ)).toBeNull();
  });
});

describe('isNoOpDrop', () => {
  const visit = { _id: 'sess-1', startTime: bizIso(2026, 7, 16, 9, 0) };

  it('a drop back onto the visit\'s own snapped start writes nothing', () => {
    expect(isNoOpDrop(visit, '2026-07-16', '2026-07-16', 9 * 60, SNAP_MINUTES_ON, BIZ)).toBe(true);
  });

  it('a drop a quarter-hour away is a real move', () => {
    expect(isNoOpDrop(visit, '2026-07-16', '2026-07-16', 9 * 60 + 15, SNAP_MINUTES_ON, BIZ)).toBe(false);
  });

  it('the same clock time on a different day is a real move', () => {
    expect(isNoOpDrop(visit, '2026-07-16', '2026-07-17', 9 * 60, SNAP_MINUTES_ON, BIZ)).toBe(false);
  });
});
