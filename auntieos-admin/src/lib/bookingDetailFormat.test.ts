import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  NOTE_CUTOFF_MS,
  DEFAULT_VISIT_MINUTES,
  notesLocked,
  noteLockReason,
  businessDateInput,
  businessTimeInput,
  visitDurationMinutes,
  durationLabel,
  buildRescheduleTimes,
  bookingWhenLabel,
} from './bookingDetailFormat';

// #1155: the DEVICE is pinned to America/Los_Angeles (UTC-7 in July) and the
// BUSINESS is America/Chicago (UTC-5), so every assertion below that reads or
// writes the business clock fails if the device zone leaks in.
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

describe('businessDateInput / businessTimeInput', () => {
  it('converts a stored UTC instant to the BUSINESS date and time, not the device one', () => {
    // 01:00Z on the 17th is 20:00 on the 16th in Chicago.
    expect(businessDateInput('2026-07-17T01:00:00.000Z', BIZ)).toBe('2026-07-16');
    expect(businessTimeInput('2026-07-17T01:00:00.000Z', BIZ)).toBe('20:00');
  });

  it('pads single-digit local components', () => {
    expect(businessDateInput('2026-01-05T15:07:00.000Z', BIZ)).toBe('2026-01-05');
    expect(businessTimeInput('2026-01-05T15:07:00.000Z', BIZ)).toBe('09:07');
  });

  it('returns blank for an absent or unparseable start, never a fabricated date', () => {
    expect(businessDateInput('', BIZ)).toBe('');
    expect(businessTimeInput('', BIZ)).toBe('');
    expect(businessDateInput('soon', BIZ)).toBe('');
    expect(businessTimeInput('soon', BIZ)).toBe('');
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
  it('reads the date and time on the BUSINESS clock, not the device one, and recomputes the end from the duration', () => {
    // 14:00 in Chicago (device is LA, which would give 21:00Z) on 2026-07-16 is 19:00Z; +90m is 20:30Z.
    expect(buildRescheduleTimes('2026-07-16', '14:00', 90, BIZ)).toEqual({
      startTime: '2026-07-16T19:00:00.000Z',
      endTime: '2026-07-16T20:30:00.000Z',
    });
  });

  it('rolls the end past midnight without corrupting the date', () => {
    expect(buildRescheduleTimes('2026-07-16', '23:30', 60, BIZ)).toEqual({
      startTime: '2026-07-17T04:30:00.000Z',
      endTime: '2026-07-17T05:30:00.000Z',
    });
  });

  it('falls back to the default duration rather than writing a zero-length visit', () => {
    const built = buildRescheduleTimes('2026-07-16', '14:00', 0, BIZ);
    expect(built).not.toBeNull();
    expect(Date.parse(built!.endTime) - Date.parse(built!.startTime)).toBe(
      DEFAULT_VISIT_MINUTES * 60_000,
    );
  });

  it('returns null on a malformed date or time so the caller fails loud', () => {
    expect(buildRescheduleTimes('16-07-2026', '14:00', 60, BIZ)).toBeNull();
    expect(buildRescheduleTimes('2026-07-16', '2pm', 60, BIZ)).toBeNull();
    expect(buildRescheduleTimes('', '', 60, BIZ)).toBeNull();
  });

  it('returns null on a calendar date that does not exist', () => {
    expect(buildRescheduleTimes('2026-02-30', '14:00', 60, BIZ)).toBeNull();
    expect(buildRescheduleTimes('2026-07-16', '25:00', 60, BIZ)).toBeNull();
  });
});

describe('bookingWhenLabel', () => {
  it('renders the viewer clock, not the stored UTC hour, when no business zone is given', () => {
    // 01:00Z on the 17th is 6:00 PM on the 16th on the LA device.
    expect(bookingWhenLabel('2026-07-17T01:00:00.000Z')).toBe('Thu, Jul 16 at 6:00 PM');
  });
  it('renders the business clock when the zone is given, whatever the device zone', () => {
    expect(bookingWhenLabel('2026-07-17T01:00:00.000Z', BIZ)).toBe('Thu, Jul 16 at 8:00 PM');
  });

  it('says the time is not set rather than inventing one', () => {
    expect(bookingWhenLabel('')).toBe('Not set');
    expect(bookingWhenLabel('sometime')).toBe('Not set');
  });
});
