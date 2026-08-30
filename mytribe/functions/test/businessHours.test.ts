import { describe, it, expect } from 'vitest';
import {
  businessHoursForDayName,
  hasSpecialHours,
  parseClosureList,
  resolveBusinessOpen,
  resolveLiveTransferEnabled,
  zonedNow,
  type BusinessHoursSettings,
} from '../src/lib/businessHours';

/**
 * The rules the business phone line answers from.
 *
 * Every case here is expressed as a real INSTANT (epoch ms) plus the settings
 * document as it actually exists in production, because the defect this module
 * replaces was not a logic error anybody could see by reading: the old handler
 * computed the right boolean and then returned a hardcoded one, and the caller
 * that asked logged `success` either way. So these tests assert the ANSWER for
 * a wall-clock moment, not the shape of the code that produces it.
 *
 * `TZ` is deliberately never set. The point of the module is that the machine's
 * own zone is irrelevant, so the suite would be worthless if it happened to
 * agree with the business's.
 */

/** The live `business_settings/business_settings` hours, verbatim, 2026-08-11. */
const LIVE_HOURS = {
  Monday: '08:00-18:00',
  Tuesday: '08:00-18:00',
  Wednesday: '08:00-18:00',
  Thursday: '08:00-18:00',
  Friday: '08:00-18:00',
  Saturday: '08:00-18:00',
  Sunday: '08:00-16:00',
};

const LIVE: BusinessHoursSettings = {
  businessHours: LIVE_HOURS,
  timeZone: 'America/Chicago',
  companyHolidays: [],
  specialHours: [],
};

/** 2026-08-11 19:01 UTC, the instant of the voicemail that exposed the outage. */
const THE_CALL_MS = Date.UTC(2026, 7, 11, 19, 1, 20);

describe('zonedNow', () => {
  it('renders an instant in the business zone, not the machine zone', () => {
    expect(zonedNow(THE_CALL_MS, 'America/Chicago')).toEqual({
      dateIso: '2026-08-11',
      timeHHmm: '14:01',
      dayName: 'Tuesday',
    });
  });

  it('renders the SAME instant differently in a different zone', () => {
    expect(zonedNow(THE_CALL_MS, 'America/New_York')?.timeHHmm).toBe('15:01');
    expect(zonedNow(THE_CALL_MS, 'UTC')?.timeHHmm).toBe('19:01');
  });

  it('renders midnight as 00:00, never 24:00', () => {
    // `hour12: false` yields "24" under some ICU builds, which sorts above every
    // closing time and would report a business open all night.
    const midnightCt = Date.UTC(2026, 7, 12, 5, 0); // 00:00 CDT
    expect(zonedNow(midnightCt, 'America/Chicago')).toMatchObject({
      timeHHmm: '00:00',
      dayName: 'Wednesday',
    });
  });

  it('crosses the local date boundary before the UTC one', () => {
    // 2026-08-12 02:00 UTC is still 2026-08-11 in Chicago.
    expect(zonedNow(Date.UTC(2026, 7, 12, 2, 0), 'America/Chicago')?.dateIso).toBe('2026-08-11');
  });

  it('tracks DST rather than a fixed offset', () => {
    // CDT (UTC-5) in August, CST (UTC-6) in January, same UTC hour.
    expect(zonedNow(Date.UTC(2026, 7, 11, 19, 0), 'America/Chicago')?.timeHHmm).toBe('14:00');
    expect(zonedNow(Date.UTC(2026, 0, 11, 19, 0), 'America/Chicago')?.timeHHmm).toBe('13:00');
  });

  it('returns null for a zone Intl does not recognise, rather than silently using UTC', () => {
    expect(zonedNow(THE_CALL_MS, 'Not/AZone')).toBeNull();
    expect(zonedNow(THE_CALL_MS, '')).toBeNull();
    expect(zonedNow(THE_CALL_MS, '   ')).toBeNull();
  });

  it('returns null for a non-finite instant', () => {
    expect(zonedNow(Number.NaN, 'America/Chicago')).toBeNull();
    expect(zonedNow(Number.POSITIVE_INFINITY, 'America/Chicago')).toBeNull();
  });
});

describe('businessHoursForDayName', () => {
  it('parses the wire format the admin editor writes', () => {
    expect(businessHoursForDayName(LIVE_HOURS, 'Tuesday')).toEqual({
      kind: 'open',
      startHHmm: '08:00',
      endHHmm: '18:00',
    });
  });

  it('zero-pads a single-digit hour so string comparison still orders correctly', () => {
    expect(businessHoursForDayName({ Monday: '9:00-17:00' }, 'Monday')).toEqual({
      kind: 'open',
      startHHmm: '09:00',
      endHHmm: '17:00',
    });
  });

  it('tolerates spaces around the dash', () => {
    expect(businessHoursForDayName({ Monday: '09:00 - 17:00' }, 'Monday')).toMatchObject({ kind: 'open' });
  });

  it('treats a blank value and an absent key alike as closed', () => {
    expect(businessHoursForDayName({ Monday: '' }, 'Monday')).toEqual({ kind: 'closed' });
    expect(businessHoursForDayName({}, 'Monday')).toEqual({ kind: 'closed' });
    expect(businessHoursForDayName(undefined, 'Monday')).toEqual({ kind: 'closed' });
  });

  it('reports free text as unreadable rather than guessing', () => {
    expect(businessHoursForDayName({ Monday: 'by appointment' }, 'Monday')).toEqual({
      kind: 'unreadable',
      raw: 'by appointment',
    });
  });

  it('rejects an out-of-range clock time as unreadable', () => {
    expect(businessHoursForDayName({ Monday: '08:00-25:00' }, 'Monday')).toMatchObject({ kind: 'unreadable' });
    expect(businessHoursForDayName({ Monday: '08:70-17:00' }, 'Monday')).toMatchObject({ kind: 'unreadable' });
  });

  it('does not throw on a legacy non-string value', () => {
    // `mergeBusinessSettings` type-checks the map but never descends into it,
    // so a legacy doc can hold a number here.
    expect(businessHoursForDayName({ Monday: 900 }, 'Monday')).toEqual({ kind: 'closed' });
    expect(businessHoursForDayName({ Monday: null }, 'Monday')).toEqual({ kind: 'closed' });
  });
});

describe('hasSpecialHours', () => {
  it('matches on the date half only', () => {
    expect(hasSpecialHours(['2026-12-24|10:00-14:00'], '2026-12-24')).toBe(true);
    expect(hasSpecialHours(['2026-12-24|10:00-14:00'], '2026-12-25')).toBe(false);
  });

  it('matches whatever free text the operator typed after the pipe', () => {
    expect(hasSpecialHours(['2026-12-24|half day'], '2026-12-24')).toBe(true);
    expect(hasSpecialHours(['2026-12-24|by appointment'], '2026-12-24')).toBe(true);
  });

  it('ignores a non-array or empty date', () => {
    expect(hasSpecialHours(undefined, '2026-12-24')).toBe(false);
    expect(hasSpecialHours('2026-12-24|x', '2026-12-24')).toBe(false);
    expect(hasSpecialHours(['2026-12-24|x'], '')).toBe(false);
  });
});

describe('resolveBusinessOpen', () => {
  it('THE REGRESSION: the call that was told "we are closed" resolves OPEN', () => {
    // 2026-08-11 14:01 CDT, a Tuesday, inside 08:00-18:00. The live flow sent
    // this caller to the after-hours greeting.
    expect(resolveBusinessOpen(LIVE, THE_CALL_MS)).toMatchObject({
      open: true,
      reason: 'open',
      uncertain: false,
      dayName: 'Tuesday',
      localTimeHHmm: '14:01',
      localDateIso: '2026-08-11',
    });
  });

  it('THE REGRESSION: Saturday is open, which Mon-Fri hardcoding got wrong', () => {
    // 2026-08-01 16:32 CDT, a Saturday. Two real calls landed here.
    expect(resolveBusinessOpen(LIVE, Date.UTC(2026, 7, 1, 21, 32))).toMatchObject({
      open: true,
      reason: 'open',
      dayName: 'Saturday',
    });
  });

  it('THE REGRESSION: Eastern-vs-Central is a real hour, not a rounding detail', () => {
    // 17:30 Central on a Sunday. Sunday closes at 16:00, so Central says closed.
    // Read as Eastern the same instant is 18:30, also closed, but at 15:30 UTC
    // the two zones disagree outright.
    const sundayLateMorning = Date.UTC(2026, 7, 9, 12, 30); // 07:30 CDT / 08:30 EDT
    expect(resolveBusinessOpen(LIVE, sundayLateMorning)).toMatchObject({
      open: false,
      reason: 'outside-hours',
      dayName: 'Sunday',
      localTimeHHmm: '07:30',
    });
    expect(
      resolveBusinessOpen({ ...LIVE, timeZone: 'America/New_York' }, sundayLateMorning),
    ).toMatchObject({ open: true, reason: 'open', localTimeHHmm: '08:30' });
  });

  it('honours the shorter Sunday close', () => {
    // 17:00 CDT Sunday: inside Mon-Sat hours, outside Sunday's 08:00-16:00.
    expect(resolveBusinessOpen(LIVE, Date.UTC(2026, 7, 9, 22, 0))).toMatchObject({
      open: false,
      reason: 'outside-hours',
      dayName: 'Sunday',
    });
  });

  it('is half-open: open exactly at opening, closed exactly at closing', () => {
    const at0800 = Date.UTC(2026, 7, 11, 13, 0); // 08:00 CDT
    const at1800 = Date.UTC(2026, 7, 11, 23, 0); // 18:00 CDT
    const at1759 = Date.UTC(2026, 7, 11, 22, 59); // 17:59 CDT
    expect(resolveBusinessOpen(LIVE, at0800)).toMatchObject({ open: true, reason: 'open' });
    expect(resolveBusinessOpen(LIVE, at1759)).toMatchObject({ open: true, reason: 'open' });
    expect(resolveBusinessOpen(LIVE, at1800)).toMatchObject({ open: false, reason: 'outside-hours' });
  });

  it('reports a blank day as closed, not outside-hours', () => {
    const settings = { ...LIVE, businessHours: { ...LIVE_HOURS, Tuesday: '' } };
    expect(resolveBusinessOpen(settings, THE_CALL_MS)).toMatchObject({
      open: false,
      reason: 'closed-day',
      uncertain: false,
    });
  });

  it('FAILS OPEN on an unreadable day and says it is uncertain', () => {
    const settings = { ...LIVE, businessHours: { ...LIVE_HOURS, Tuesday: 'by appointment' } };
    expect(resolveBusinessOpen(settings, THE_CALL_MS)).toMatchObject({
      open: true,
      reason: 'unreadable-hours',
      uncertain: true,
    });
  });

  it('closes on a company holiday even during business hours', () => {
    const settings = { ...LIVE, companyHolidays: ['2026-08-11|Staff day'] };
    expect(resolveBusinessOpen(settings, THE_CALL_MS)).toMatchObject({
      open: false,
      reason: 'company-holiday',
      uncertain: false,
    });
  });

  it('closes on a RECURRING company holiday', () => {
    const settings = { ...LIVE, companyHolidays: ['yearly:08-11|Founders Day'] };
    expect(resolveBusinessOpen(settings, THE_CALL_MS)).toMatchObject({
      open: false,
      reason: 'company-holiday',
    });
  });

  it('a company holiday on another date does not close today', () => {
    const settings = { ...LIVE, companyHolidays: ['2026-08-12|Staff day'] };
    expect(resolveBusinessOpen(settings, THE_CALL_MS)).toMatchObject({ open: true, reason: 'open' });
  });

  it('a corrupt company holiday row never closes the line', () => {
    // `parseClosureEntry` never throws; a garbage row decodes to date '' and
    // resolves to zero occurrences.
    const settings = { ...LIVE, companyHolidays: ['not a closure at all', '', 42] };
    expect(resolveBusinessOpen(settings, THE_CALL_MS)).toMatchObject({ open: true, reason: 'open' });
  });

  it('FAILS OPEN on a specialHours day, because the weekly pattern is known wrong there', () => {
    const settings = { ...LIVE, specialHours: ['2026-08-11|10:00-14:00'] };
    expect(resolveBusinessOpen(settings, THE_CALL_MS)).toMatchObject({
      open: true,
      reason: 'special-hours-unknown',
      uncertain: true,
    });
  });

  it('a company holiday OUTRANKS specialHours on the same date', () => {
    const settings = {
      ...LIVE,
      companyHolidays: ['2026-08-11|Closed'],
      specialHours: ['2026-08-11|10:00-14:00'],
    };
    expect(resolveBusinessOpen(settings, THE_CALL_MS)).toMatchObject({
      open: false,
      reason: 'company-holiday',
    });
  });

  it('specialHours OUTRANKS a blank weekly day', () => {
    const settings = {
      ...LIVE,
      businessHours: { ...LIVE_HOURS, Tuesday: '' },
      specialHours: ['2026-08-11|open late'],
    };
    expect(resolveBusinessOpen(settings, THE_CALL_MS)).toMatchObject({
      open: true,
      reason: 'special-hours-unknown',
    });
  });

  it('FAILS OPEN, loudly, on an unusable timezone rather than defaulting to UTC', () => {
    for (const timeZone of ['', '   ', 'Not/AZone', 'EST5EDT-nonsense']) {
      expect(resolveBusinessOpen({ ...LIVE, timeZone }, THE_CALL_MS)).toMatchObject({
        open: true,
        reason: 'timezone-unusable',
        uncertain: true,
      });
    }
  });

  it('FAILS OPEN on an entirely empty settings document', () => {
    // No hours at all is not evidence of being shut; it is evidence nobody has
    // configured the line yet.
    expect(resolveBusinessOpen({}, THE_CALL_MS)).toMatchObject({
      open: true,
      reason: 'timezone-unusable',
      uncertain: true,
    });
  });

  it('reports closed-day when the zone is fine but hours are entirely missing', () => {
    expect(resolveBusinessOpen({ timeZone: 'America/Chicago' }, THE_CALL_MS)).toMatchObject({
      open: false,
      reason: 'closed-day',
      uncertain: false,
    });
  });

  it('echoes the zone it used, so one log line explains itself', () => {
    expect(resolveBusinessOpen(LIVE, THE_CALL_MS).timeZone).toBe('America/Chicago');
  });
});

describe('parseClosureList', () => {
  it('drops non-strings and never throws', () => {
    expect(parseClosureList(['2026-01-01|New Year', 7, null, undefined])).toHaveLength(1);
    expect(parseClosureList(undefined)).toEqual([]);
    expect(parseClosureList('nope')).toEqual([]);
  });
});

/**
 * ISSUE #397. The whole rule is "only an explicit false turns it off", and it
 * is spelled out case by case because the value this reads is raw document
 * data: nothing validates the field on the way in, so a legacy document or a
 * hand-edit in the Firebase console can put anything at all there.
 */
describe('resolveLiveTransferEnabled', () => {
  it('is ON when the field is absent, so no document written before it goes quiet', () => {
    expect(resolveLiveTransferEnabled({})).toBe(true);
    expect(resolveLiveTransferEnabled({ timeZone: 'America/Chicago' })).toBe(true);
  });

  it('is ON when the settings could not be read at all', () => {
    // Fail-open, matching the hours. Not knowing is not a reason to stop
    // connecting callers.
    expect(resolveLiveTransferEnabled(null)).toBe(true);
  });

  it('is OFF only for an explicit boolean false', () => {
    expect(resolveLiveTransferEnabled({ voiceLiveTransferEnabled: false })).toBe(false);
    expect(resolveLiveTransferEnabled({ voiceLiveTransferEnabled: true })).toBe(true);
  });

  it('treats a NON-BOOLEAN as on rather than guessing what it meant', () => {
    // A string "false" is the shape a hand-edited console value takes, and it
    // is exactly the value that must not silently disable the phone. Turning
    // the line off is an explicit act, so it takes an explicit boolean.
    const cases: unknown[] = ['false', 'off', 0, '', null, [], {}];
    for (const value of cases) {
      expect(resolveLiveTransferEnabled({ voiceLiveTransferEnabled: value })).toBe(true);
    }
  });
});
