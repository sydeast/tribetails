import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  businessHoursKeyForIso,
  businessHoursForDay,
  dayHoursLabel,
  isWithinBusinessHours,
  blockedWindows,
  clashingBlocks,
  dayBadge,
  dayDescription,
  selectionWarnings,
  shortDayLabel,
  type DayAvailability,
} from './bookingAvailability';

// Every helper here reads a LOCAL calendar day; pin the zone so the weekday a
// bare YYYY-MM-DD resolves to is stable, and pin it WEST of Greenwich so a
// UTC-parsing regression would name the wrong day rather than accidentally
// passing.
const ORIG_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  process.env.TZ = ORIG_TZ;
});

/** A day with nothing remarkable about it, for spreading. */
function day(over: Partial<DayAvailability> = {}): DayAvailability {
  return {
    iso: '2026-08-03',
    past: false,
    hours: { kind: 'open', startHHmm: '09:00', endHHmm: '17:00' },
    hoursKnown: true,
    blocked: [],
    sessionCount: 0,
    scheduleKnown: true,
    ...over,
  };
}

describe('businessHoursKeyForIso', () => {
  it('names the weekday businessHours is actually keyed by', () => {
    // 2026-08-03 is a Monday, 2026-08-09 a Sunday.
    expect(businessHoursKeyForIso('2026-08-03')).toBe('Monday');
    expect(businessHoursKeyForIso('2026-08-09')).toBe('Sunday');
  });
});

describe('businessHoursForDay', () => {
  const HOURS = { Monday: '09:00-17:00', Tuesday: '', Wednesday: '9:00-17:30', Thursday: 'by appt' };

  it('reads a well-formed range', () => {
    expect(businessHoursForDay(HOURS, '2026-08-03')).toEqual({
      kind: 'open',
      startHHmm: '09:00',
      endHHmm: '17:00',
    });
  });

  it('zero-pads a single-digit hour so plain string comparison still orders it', () => {
    // Wednesday. "9:00" would compare GREATER than "17:00" unpadded.
    expect(businessHoursForDay(HOURS, '2026-08-05')).toEqual({
      kind: 'open',
      startHHmm: '09:00',
      endHHmm: '17:30',
    });
  });

  it('treats a blank entry, and a missing key, as closed', () => {
    expect(businessHoursForDay(HOURS, '2026-08-04')).toEqual({ kind: 'closed' }); // Tuesday, ''
    expect(businessHoursForDay(HOURS, '2026-08-07')).toEqual({ kind: 'closed' }); // Friday, absent
  });

  it('keeps a legacy value it cannot parse as unreadable, never as closed', () => {
    // Saying "Closed" on the strength of a failed regex is the lie this avoids.
    expect(businessHoursForDay(HOURS, '2026-08-06')).toEqual({ kind: 'unreadable', raw: 'by appt' });
  });

  it('survives a non-string value from a legacy doc', () => {
    const legacy = { Monday: 900 } as unknown as Record<string, string>;
    expect(() => businessHoursForDay(legacy, '2026-08-03')).not.toThrow();
    expect(businessHoursForDay(legacy, '2026-08-03').kind).toBe('closed');
  });

  it('rejects an in-format but impossible clock time', () => {
    expect(businessHoursForDay({ Monday: '09:00-25:00' }, '2026-08-03')).toEqual({
      kind: 'unreadable',
      raw: '09:00-25:00',
    });
  });
});

describe('dayHoursLabel', () => {
  it('renders 12h for an open day, the raw text for an unreadable one', () => {
    expect(dayHoursLabel({ kind: 'open', startHHmm: '09:00', endHHmm: '17:00' })).toBe(
      '9:00 AM to 5:00 PM',
    );
    expect(dayHoursLabel({ kind: 'unreadable', raw: 'by appt' })).toBe('by appt');
    expect(dayHoursLabel({ kind: 'closed' })).toBe('Closed');
  });
});

describe('isWithinBusinessHours', () => {
  const open = { kind: 'open', startHHmm: '09:00', endHHmm: '17:00' } as const;

  it('is half-open: inclusive at opening, exclusive at closing', () => {
    expect(isWithinBusinessHours('09:00', open)).toBe(true);
    expect(isWithinBusinessHours('16:59', open)).toBe(true);
    expect(isWithinBusinessHours('17:00', open)).toBe(false);
    expect(isWithinBusinessHours('08:59', open)).toBe(false);
  });

  it('is never inside a closed day', () => {
    expect(isWithinBusinessHours('12:00', { kind: 'closed' })).toBe(false);
  });

  it('does not nag about a range it could not parse', () => {
    expect(isWithinBusinessHours('12:00', { kind: 'unreadable', raw: 'by appt' })).toBe(true);
  });
});

describe('blockedWindows and clashingBlocks', () => {
  const SLOTS = [
    { date: '2026-08-03', startTime: '08:00', endTime: '12:00', slotType: 'BLOCKED' },
    { date: '2026-08-03', startTime: '', endTime: '', slotType: 'BLOCKED' },
  ];

  it('labels each window for display', () => {
    expect(blockedWindows(SLOTS).map((w) => w.label)).toEqual(['8:00 AM to 12:00 PM', 'Time TBD']);
  });

  it('flags a start inside a window, half-open at each end', () => {
    const windows = blockedWindows(SLOTS);
    expect(clashingBlocks('09:00', windows).map((w) => w.label)).toEqual(['8:00 AM to 12:00 PM']);
    expect(clashingBlocks('08:00', windows)).toHaveLength(1);
    expect(clashingBlocks('12:00', windows)).toHaveLength(0);
    expect(clashingBlocks('07:59', windows)).toHaveLength(0);
  });

  it('never treats a window with no readable times as a clash', () => {
    // It still marks the DAY (the caller counts `blocked.length`), it just
    // cannot contradict a specific start time with a boundary nobody wrote.
    const tbdOnly = blockedWindows([SLOTS[1]!]);
    expect(clashingBlocks('09:00', tbdOnly)).toEqual([]);
  });
});

describe('dayBadge', () => {
  it('says nothing about an ordinary open day', () => {
    expect(dayBadge(day())).toBeNull();
  });
  it('says nothing about a past day, which is already unpickable', () => {
    expect(dayBadge(day({ past: true, hours: { kind: 'closed' } }))).toBeNull();
  });
  it('ranks blocked above closed above a visit count', () => {
    const blocked = [{ label: '8:00 AM to 12:00 PM', startHHmm: '08:00', endHHmm: '12:00' }];
    expect(dayBadge(day({ blocked, hours: { kind: 'closed' }, sessionCount: 2 }))).toBe('Blocked');
    expect(dayBadge(day({ hours: { kind: 'closed' }, sessionCount: 2 }))).toBe('Closed');
    expect(dayBadge(day({ sessionCount: 2 }))).toBe('2');
  });
  it('claims nothing at all once a read has failed', () => {
    // The marks belong to data we no longer have. An unmarked cell here means
    // "unknown", and the dialog's banner is what says so.
    expect(dayBadge(day({ hoursKnown: false, hours: { kind: 'closed' } }))).toBeNull();
    expect(dayBadge(day({ scheduleKnown: false, sessionCount: 4 }))).toBeNull();
  });
});

describe('dayDescription', () => {
  it('speaks the open window a sighted operator only sees implicitly', () => {
    expect(dayDescription(day())).toBe('open 9:00 AM to 5:00 PM');
  });
  it('says a past day is not available', () => {
    expect(dayDescription(day({ past: true }))).toBe('in the past, not available');
  });
  it('says availability is unknown rather than staying silent after a failed read', () => {
    expect(dayDescription(day({ hoursKnown: false, scheduleKnown: false }))).toBe(
      'availability unknown',
    );
  });
  it('names the blocked windows and the existing visit count', () => {
    const d = day({
      hours: { kind: 'closed' },
      blocked: [{ label: '8:00 AM to 12:00 PM', startHHmm: '08:00', endHHmm: '12:00' }],
      sessionCount: 1,
    });
    expect(dayDescription(d)).toBe(
      'business closed, blocked 8:00 AM to 12:00 PM, 1 visit already scheduled',
    );
  });
});

describe('selectionWarnings', () => {
  it('is empty for a selection that sits inside open hours', () => {
    expect(selectionWarnings([day()], '10:00')).toEqual([]);
  });

  it('names the day the business is closed', () => {
    expect(selectionWarnings([day({ hours: { kind: 'closed' } })], '10:00')).toEqual([
      'Aug 3: the business is closed that day.',
    ]);
  });

  it('names an out-of-hours start and quotes the real window', () => {
    expect(selectionWarnings([day()], '19:00')).toEqual([
      'Aug 3: 19:00 is outside business hours (9:00 AM to 5:00 PM).',
    ]);
  });

  it('names a blocked window the start lands in', () => {
    const d = day({
      blocked: [{ label: '9:00 AM to 11:00 AM', startHHmm: '09:00', endHHmm: '11:00' }],
    });
    expect(selectionWarnings([d], '10:00')).toEqual(['Aug 3: blocked time at 9:00 AM to 11:00 AM.']);
  });

  it('stays silent about a day whose availability could not be read', () => {
    // The dialog already shows one banner for the failed read; repeating it per
    // day would bury the days we do know something about.
    const unknown = day({ hoursKnown: false, scheduleKnown: false, hours: { kind: 'closed' } });
    expect(selectionWarnings([unknown], '19:00')).toEqual([]);
  });

  it('reports every offending day, in the order given', () => {
    const warnings = selectionWarnings(
      [day({ iso: '2026-08-03', hours: { kind: 'closed' } }), day({ iso: '2026-08-05' })],
      '19:00',
    );
    expect(warnings).toEqual([
      'Aug 3: the business is closed that day.',
      'Aug 5: 19:00 is outside business hours (9:00 AM to 5:00 PM).',
    ]);
  });
});

describe('shortDayLabel', () => {
  it('reads a local YYYY-MM-DD without routing through Date parsing', () => {
    expect(shortDayLabel('2026-08-03')).toBe('Aug 3');
    expect(shortDayLabel('2027-01-31')).toBe('Jan 31');
  });
});
