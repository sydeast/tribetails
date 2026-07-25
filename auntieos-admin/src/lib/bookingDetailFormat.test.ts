import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  NOTE_CUTOFF_MS,
  DEFAULT_VISIT_MINUTES,
  notesLocked,
  noteLockReason,
  localDateInput,
  localTimeInput,
  visitDurationMinutes,
  durationLabel,
  buildRescheduleTimes,
  bookingWhenLabel,
} from './bookingDetailFormat';

// Pinned west of UTC so every "the stored instant is UTC, the operator reads
// local" assertion below is meaningful on any CI runner (the
// sessionFormat.test.ts / Schedule.test.tsx convention). America/Chicago is
// UTC-5 in July.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('NOTE_CUTOFF_MS', () => {
  it('is three hours, as one shared constant', () => {
    expect(NOTE_CUTOFF_MS).toBe(3 * 60 * 60 * 1000);
  });
});

describe('notesLocked', () => {
  const start = '2026-07-16T19:00:00.000Z';
  const startMs = Date.parse(start);

  it('is open more than three hours before the start', () => {
    expect(notesLocked(start, startMs - NOTE_CUTOFF_MS - 1)).toBe(false);
  });

  it('locks exactly at the three hour mark', () => {
    expect(notesLocked(start, startMs - NOTE_CUTOFF_MS)).toBe(true);
  });

  it('stays locked after the visit has started', () => {
    expect(notesLocked(start, startMs + 60_000)).toBe(true);
  });

  it('leaves notes open when the start time is missing or unparseable', () => {
    // Degrade honestly: a session with no start has no cutoff to be inside of,
    // and the server is the real gate either way.
    expect(notesLocked('', 1)).toBe(false);
    expect(notesLocked('whenever', 1)).toBe(false);
  });
});

describe('noteLockReason', () => {
  it('says why rather than only disabling', () => {
    expect(noteLockReason()).toMatch(/3 hours/);
    expect(noteLockReason()).toMatch(/lock/i);
  });

  it('uses no em dash', () => {
    expect(noteLockReason()).not.toContain('—');
  });
});

describe('localDateInput / localTimeInput', () => {
  it('converts a stored UTC instant to the operator LOCAL date and time', () => {
    // 01:00Z on the 17th is 20:00 on the 16th in Chicago.
    expect(localDateInput('2026-07-17T01:00:00.000Z')).toBe('2026-07-16');
    expect(localTimeInput('2026-07-17T01:00:00.000Z')).toBe('20:00');
  });

  it('pads single-digit local components', () => {
    expect(localDateInput('2026-01-05T15:07:00.000Z')).toBe('2026-01-05');
    expect(localTimeInput('2026-01-05T15:07:00.000Z')).toBe('09:07');
  });

  it('returns blank for an absent or unparseable start, never a fabricated date', () => {
    expect(localDateInput('')).toBe('');
    expect(localTimeInput('')).toBe('');
    expect(localDateInput('soon')).toBe('');
    expect(localTimeInput('soon')).toBe('');
  });
});

describe('visitDurationMinutes', () => {
  it('prefers the stored serviceDurationMinutes', () => {
    expect(
      visitDurationMinutes({
        serviceDurationMinutes: 90,
        startTime: '2026-07-16T14:00:00.000Z',
        endTime: '2026-07-16T15:00:00.000Z',
      }),
    ).toBe(90);
  });

  it('derives from the start/end window when the stored duration is absent', () => {
    expect(
      visitDurationMinutes({
        startTime: '2026-07-16T14:00:00.000Z',
        endTime: '2026-07-16T15:30:00.000Z',
      }),
    ).toBe(90);
  });

  it('falls back to the default when neither is usable', () => {
    expect(visitDurationMinutes({})).toBe(DEFAULT_VISIT_MINUTES);
    expect(visitDurationMinutes({ serviceDurationMinutes: 0 })).toBe(DEFAULT_VISIT_MINUTES);
    // An end before the start is garbage, not a negative visit.
    expect(
      visitDurationMinutes({
        startTime: '2026-07-16T15:00:00.000Z',
        endTime: '2026-07-16T14:00:00.000Z',
      }),
    ).toBe(DEFAULT_VISIT_MINUTES);
  });
});

describe('durationLabel', () => {
  it('reads in hours and minutes', () => {
    expect(durationLabel(45)).toBe('45 min');
    expect(durationLabel(60)).toBe('1 hr');
    expect(durationLabel(90)).toBe('1 hr 30 min');
    expect(durationLabel(150)).toBe('2 hr 30 min');
  });

  it('says nothing is recorded rather than showing "0 min"', () => {
    expect(durationLabel(0)).toBe('Not recorded');
    expect(durationLabel(-5)).toBe('Not recorded');
  });
});

describe('buildRescheduleTimes', () => {
  it('reads the date and time as LOCAL and recomputes the end from the duration', () => {
    // 14:00 in Chicago on 2026-07-16 is 19:00Z; +90m is 20:30Z.
    expect(buildRescheduleTimes('2026-07-16', '14:00', 90)).toEqual({
      startTime: '2026-07-16T19:00:00.000Z',
      endTime: '2026-07-16T20:30:00.000Z',
    });
  });

  it('rolls the end past midnight without corrupting the date', () => {
    expect(buildRescheduleTimes('2026-07-16', '23:30', 60)).toEqual({
      startTime: '2026-07-17T04:30:00.000Z',
      endTime: '2026-07-17T05:30:00.000Z',
    });
  });

  it('falls back to the default duration rather than writing a zero-length visit', () => {
    const built = buildRescheduleTimes('2026-07-16', '14:00', 0);
    expect(built).not.toBeNull();
    expect(Date.parse(built!.endTime) - Date.parse(built!.startTime)).toBe(
      DEFAULT_VISIT_MINUTES * 60_000,
    );
  });

  it('returns null on a malformed date or time so the caller fails loud', () => {
    expect(buildRescheduleTimes('16-07-2026', '14:00', 60)).toBeNull();
    expect(buildRescheduleTimes('2026-07-16', '2pm', 60)).toBeNull();
    expect(buildRescheduleTimes('', '', 60)).toBeNull();
  });

  it('returns null on a calendar date that does not exist', () => {
    expect(buildRescheduleTimes('2026-02-30', '14:00', 60)).toBeNull();
    expect(buildRescheduleTimes('2026-07-16', '25:00', 60)).toBeNull();
  });
});

describe('bookingWhenLabel', () => {
  it('renders the LOCAL day and clock time, not the stored UTC hour', () => {
    expect(bookingWhenLabel('2026-07-17T01:00:00.000Z')).toBe('Thu, Jul 16 at 8:00 PM');
  });

  it('says the time is not set rather than inventing one', () => {
    expect(bookingWhenLabel('')).toBe('Not set');
    expect(bookingWhenLabel('sometime')).toBe('Not set');
  });
});
