import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  addCalendarDays,
  mondayOfWeek,
  weekDays,
  monthGridDays,
  weekdayAbbrev,
  rangeLabel,
  shiftRange,
  sessionsByLocalDay,
  sessionCountForDay,
  busySlotKind,
  groupBlockedSlotsByDate,
  isValidHHmm,
  formatHHmm12h,
  busyWindowLabel,
  distinctServiceTypes,
} from './scheduleFormat';

// File-scope TZ pin (the sessionFormat.test.ts / Sessions.test.tsx convention):
// `sessionsByLocalDay` derives its keys from the AO-18-fixed `sessionDayKey`,
// which parses a UTC-suffixed ISO instant into a LOCAL calendar day. Pinning to
// a west-of-UTC zone makes that meaningful on any CI runner (a UTC-default
// runner would make "local" and "UTC" the same day, silently passing a broken
// implementation too).
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('addCalendarDays / mondayOfWeek / weekDays', () => {
  it('adds whole calendar days without drifting across a month boundary', () => {
    expect(addCalendarDays('2026-07-30', 3)).toBe('2026-08-02');
  });

  it('subtracts across a year boundary', () => {
    expect(addCalendarDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('finds the Monday on or before a mid-week day', () => {
    // 2026-07-16 is a Thursday.
    expect(mondayOfWeek('2026-07-16')).toBe('2026-07-13');
  });

  it('finds the Monday of a day that already IS a Monday (no-op)', () => {
    expect(mondayOfWeek('2026-07-13')).toBe('2026-07-13');
  });

  it('returns 7 Monday-first calendar days for the containing week', () => {
    expect(weekDays('2026-07-16')).toEqual([
      '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16',
      '2026-07-17', '2026-07-18', '2026-07-19',
    ]);
  });

  it('a Sunday selection still resolves to the SAME (Mon-Sun) week, not the next one', () => {
    expect(weekDays('2026-07-19')).toEqual(weekDays('2026-07-16'));
  });
});

describe('monthGridDays', () => {
  it('always returns a fixed 6-week (42-day), Monday-first grid', () => {
    expect(monthGridDays('2026-07-16')).toHaveLength(42);
  });

  it('the grid start is on or before the 1st of the month, and is itself a Monday', () => {
    const days = monthGridDays('2026-07-16');
    const first = days[0] as string;
    expect(first <= '2026-07-01').toBe(true);
    expect(mondayOfWeek(first)).toBe(first);
  });

  it('the grid fully covers every day of the month with no truncation', () => {
    const days = monthGridDays('2026-02-16'); // Feb 2026: 1st is a Sunday
    expect(days).toContain('2026-02-01');
    expect(days).toContain('2026-02-28');
  });
});

describe('weekdayAbbrev', () => {
  it('labels a known Thursday correctly', () => {
    expect(weekdayAbbrev('2026-07-16')).toBe('Thu');
  });
});

describe('rangeLabel', () => {
  it('day view: month + day, no year', () => {
    expect(rangeLabel('2026-07-16', 'day')).toBe('Jul 16');
  });

  it('week view within one month', () => {
    expect(rangeLabel('2026-07-16', 'week')).toBe('Jul 13 to 19');
  });

  it('week view spanning two months', () => {
    // 2026-07-30 is a Thursday; its Mon-Sun week runs Jul 27 to Aug 2.
    expect(rangeLabel('2026-07-30', 'week')).toBe('Jul 27 to Aug 2');
  });

  it('month view: full month name + year', () => {
    expect(rangeLabel('2026-07-16', 'month')).toBe('July 2026');
  });
});

describe('shiftRange', () => {
  it('day view steps by one calendar day', () => {
    expect(shiftRange('2026-07-16', 'day', 1)).toBe('2026-07-17');
    expect(shiftRange('2026-07-16', 'day', -1)).toBe('2026-07-15');
  });

  it('week view steps by 7 calendar days', () => {
    expect(shiftRange('2026-07-16', 'week', 1)).toBe('2026-07-23');
  });

  it('month view steps by one calendar month, preserving day-of-month', () => {
    expect(shiftRange('2026-07-16', 'month', 1)).toBe('2026-08-16');
    expect(shiftRange('2026-07-16', 'month', -1)).toBe('2026-06-16');
  });

  it('month view clamps an overflowing day-of-month (Jan 31 -> Feb 28 in a non-leap year)', () => {
    expect(shiftRange('2025-01-31', 'month', 1)).toBe('2025-02-28');
  });

  it('month view rolls the year over on a December -> January step', () => {
    expect(shiftRange('2026-12-16', 'month', 1)).toBe('2027-01-16');
  });
});

describe('sessionsByLocalDay / sessionCountForDay (AO-18)', () => {
  interface Row {
    startTime: string;
  }

  it('groups a late-evening local session under its LOCAL day, not the UTC-next day', () => {
    // 2026-07-16 20:00 America/Chicago (CDT, UTC-5) round-trips as this UTC instant.
    const byDay = sessionsByLocalDay<Row>([{ startTime: '2026-07-17T01:00:00.000Z' }]);
    expect(sessionCountForDay(byDay, '2026-07-16')).toBe(1);
    expect(sessionCountForDay(byDay, '2026-07-17')).toBe(0);
  });

  it('an empty/missing day has a count of 0, never absent/undefined leaking through', () => {
    const byDay = sessionsByLocalDay<Row>([]);
    expect(sessionCountForDay(byDay, '2026-07-16')).toBe(0);
  });

  it('counts every session that lands on the same local day', () => {
    const byDay = sessionsByLocalDay<Row>([
      { startTime: '2026-07-16T14:00:00.000Z' },
      { startTime: '2026-07-16T18:00:00.000Z' },
    ]);
    expect(sessionCountForDay(byDay, '2026-07-16')).toBe(2);
  });
});

describe('busySlotKind (positive slotType classification)', () => {
  it('classifies the one real slotType writers set', () => {
    expect(busySlotKind('BLOCKED')).toBe('blocked');
  });

  it('is case-insensitive', () => {
    expect(busySlotKind('blocked')).toBe('blocked');
  });

  it('AO-12-style guard: any unrecognized slotType is "unknown", never silently folded into "blocked"', () => {
    expect(busySlotKind('AVAILABLE')).toBe('unknown');
    expect(busySlotKind('')).toBe('unknown');
  });
});

describe('groupBlockedSlotsByDate', () => {
  interface Slot {
    date: string;
    startTime: string;
    endTime: string;
    slotType: string;
  }

  it('keeps only BLOCKED slots, dropping any other/unknown slotType', () => {
    const grouped = groupBlockedSlotsByDate<Slot>([
      { date: '2026-07-16', startTime: '08:00', endTime: '09:00', slotType: 'BLOCKED' },
      { date: '2026-07-16', startTime: '10:00', endTime: '11:00', slotType: 'SOMETHING_NEW' },
    ]);
    expect(grouped.get('2026-07-16')).toHaveLength(1);
  });

  it('drops a slot with a blank date (cannot be placed on a calendar day)', () => {
    const grouped = groupBlockedSlotsByDate<Slot>([
      { date: '', startTime: '08:00', endTime: '09:00', slotType: 'BLOCKED' },
    ]);
    expect(grouped.size).toBe(0);
  });

  it('sorts each day\'s slots by startTime ascending', () => {
    const grouped = groupBlockedSlotsByDate<Slot>([
      { date: '2026-07-16', startTime: '14:00', endTime: '15:00', slotType: 'BLOCKED' },
      { date: '2026-07-16', startTime: '08:00', endTime: '09:00', slotType: 'BLOCKED' },
    ]);
    expect(grouped.get('2026-07-16')?.map((s) => s.startTime)).toEqual(['08:00', '14:00']);
  });
});

describe('isValidHHmm / formatHHmm12h', () => {
  it('accepts a valid 24h HH:mm', () => {
    expect(isValidHHmm('08:00')).toBe(true);
    expect(isValidHHmm('23:59')).toBe(true);
  });

  it('rejects an out-of-range or malformed value, never fabricating a time', () => {
    expect(isValidHHmm('24:00')).toBe(false);
    expect(isValidHHmm('08:60')).toBe(false);
    expect(isValidHHmm('8:00')).toBe(false);
    expect(isValidHHmm('')).toBe(false);
  });

  it('formats morning, noon, and evening correctly', () => {
    expect(formatHHmm12h('08:00')).toBe('8:00 AM');
    expect(formatHHmm12h('12:00')).toBe('12:00 PM');
    expect(formatHHmm12h('00:00')).toBe('12:00 AM');
    expect(formatHHmm12h('23:30')).toBe('11:30 PM');
  });

  it('returns null (not a guess) for an unparseable value', () => {
    expect(formatHHmm12h('not-a-time')).toBeNull();
  });
});

describe('busyWindowLabel', () => {
  it('"Time TBD" only when BOTH ends are unparseable', () => {
    expect(busyWindowLabel('', '')).toBe('Time TBD');
  });

  it('shows just the start when only the end is unparseable', () => {
    expect(busyWindowLabel('08:00', '')).toBe('8:00 AM');
  });

  it('shows just the end when only the start is unparseable', () => {
    expect(busyWindowLabel('', '09:00')).toBe('9:00 AM');
  });

  it('shows the full window when both ends parse', () => {
    expect(busyWindowLabel('08:00', '09:30')).toBe('8:00 AM to 9:30 AM');
  });
});

describe('distinctServiceTypes', () => {
  interface Row {
    serviceType: string;
  }

  it('dedupes and sorts alphabetically', () => {
    expect(
      distinctServiceTypes<Row>([
        { serviceType: 'Dog Walk' },
        { serviceType: 'Drop-in' },
        { serviceType: 'Dog Walk' },
      ]),
    ).toEqual(['Dog Walk', 'Drop-in']);
  });

  it('drops blank service types rather than showing an empty legend entry', () => {
    expect(distinctServiceTypes<Row>([{ serviceType: '' }, { serviceType: '  ' }])).toEqual([]);
  });
});
