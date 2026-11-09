import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatWhen } from './time';
import { formatLocalDate, formatLocalDateTime } from './bookingFormat';
import { activityDayLabel } from './activityDetail';
import { humanizeDate } from './invoiceFormat';
import { formatReminderTime } from './invoiceReminder';
import { noteWhen } from '../components/VisitInternalNotes';
/**
 * #1599: a list that spans more than a year says which year a row is from, and
 * the year is read in the operator's zone (America/Chicago), so a row stamped
 * 23:30 on New Year's Eve is not filed under the next year because the UTC
 * calendar already turned over.
 */
const CHICAGO = 'America/Chicago';
let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env['TZ'];
  process.env['TZ'] = CHICAGO;
});
afterAll(() => {
  if (savedTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = savedTz;
});
// 2027-01-01 05:30 UTC is 2026-12-31 23:30 in Chicago (CST, UTC-6).
const NEW_YEARS_EVE_CHICAGO = new Date('2027-01-01T05:30:00.000Z');
// 2027-01-01 06:30 UTC is 2027-01-01 00:30 in Chicago.
const NEW_YEAR_CHICAGO = new Date('2027-01-01T06:30:00.000Z');
const NOW_2026 = new Date(2026, 11, 31, 12, 0);
describe('the test zone', () => {
  it('is really America/Chicago, so the boundary cases below mean what they say', () => {
    expect(NEW_YEARS_EVE_CHICAGO.getFullYear()).toBe(2026);
    expect(NEW_YEARS_EVE_CHICAGO.getMonth()).toBe(11);
    expect(NEW_YEARS_EVE_CHICAGO.getDate()).toBe(31);
    expect(NEW_YEAR_CHICAGO.getFullYear()).toBe(2027);
  });
});
describe('formatWhen (KinTales, Notifications, Tribal Intel)', () => {
  it('omits the year for this year', () => {
    expect(formatWhen(new Date(2026, 6, 2, 14, 2), NOW_2026)).toBe('07-02 14:02');
  });
  it('leads with the year for another year', () => {
    expect(formatWhen(new Date(2025, 6, 2, 14, 2), NOW_2026)).toBe('2025-07-02 14:02');
  });
  it('reads the year in Chicago at the boundary: 23:30 Dec 31 is still 2026', () => {
    expect(formatWhen(NEW_YEARS_EVE_CHICAGO, NOW_2026)).toBe('12-31 23:30');
  });
  it('and 00:30 Jan 1 is already 2027', () => {
    expect(formatWhen(NEW_YEAR_CHICAGO, NOW_2026)).toBe('2027-01-01 00:30');
  });
});
describe('humanizeDate (invoice rows, Link visits)', () => {
  it('omits the year for today\'s year and names it otherwise', () => {
    expect(humanizeDate('2026-07-02', '2026-11-09')).toBe('Jul 2');
    expect(humanizeDate('2025-07-02', '2026-11-09')).toBe('Jul 2, 2025');
  });
  it('compares calendar dates, so Dec 31 vs Jan 1 does not drift with a zone', () => {
    expect(humanizeDate('2026-12-31', '2026-12-31')).toBe('Dec 31');
    expect(humanizeDate('2026-12-31', '2027-01-01')).toBe('Dec 31, 2026');
  });
  it('shows an unreadable date as stored', () => {
    expect(humanizeDate('sometime in July', '2026-11-09')).toBe('sometime in July');
  });
});
describe('bookings rows: formatLocalDate / formatLocalDateTime', () => {
  it('omits the year this year', () => {
    expect(formatLocalDate(new Date(2026, 6, 16), NOW_2026)).toBe('Jul 16');
    expect(formatLocalDateTime(new Date(2026, 6, 16, 9, 0), NOW_2026)).toBe('Jul 16, 9:00 AM');
  });
  it('names the year for another year', () => {
    expect(formatLocalDate(new Date(2025, 6, 16), NOW_2026)).toBe('Jul 16, 2025');
    expect(formatLocalDateTime(new Date(2025, 6, 16, 9, 0), NOW_2026)).toBe('Jul 16, 2025, 9:00 AM');
  });
  it('reads the boundary in Chicago', () => {
    expect(formatLocalDate(NEW_YEARS_EVE_CHICAGO, NOW_2026)).toBe('Dec 31');
    expect(formatLocalDate(NEW_YEAR_CHICAGO, NOW_2026)).toBe('Jan 1, 2027');
  });
});
describe('activity log day headings', () => {
  it('keeps "Today" and "Yesterday" and omits the year in the current year', () => {
    expect(activityDayLabel('2026-11-09', '2026-11-09')).toBe('Today · Nov 9');
    expect(activityDayLabel('2026-11-08', '2026-11-09')).toBe('Yesterday · Nov 8');
    expect(activityDayLabel('2026-05-24', '2026-11-09')).toBe('May 24');
  });
  it('names the year for a day from another year', () => {
    expect(activityDayLabel('2025-05-24', '2026-11-09')).toBe('May 24, 2025');
  });
  it('keeps Yesterday across New Year without a year, since Yesterday already says it', () => {
    expect(activityDayLabel('2026-12-31', '2027-01-01')).toBe('Yesterday · Dec 31');
  });
  it('returns an undated key as it came', () => {
    expect(activityDayLabel('Undated', '2026-11-09')).toBe('Undated');
  });
});
describe('visit note and reminder stamps', () => {
  it('noteWhen names the year only outside the current business-zone year', () => {
    const jul2026 = Date.parse('2026-07-02T20:00:00Z');
    const jul2025 = Date.parse('2025-07-02T20:00:00Z');
    expect(noteWhen(jul2026, CHICAGO, NOW_2026)).toBe('Jul 2, 3:00 PM');
    expect(noteWhen(jul2025, CHICAGO, NOW_2026)).toBe('Jul 2, 2025, 3:00 PM');
    expect(noteWhen(null, CHICAGO, NOW_2026)).toBe('');
  });
  it('noteWhen reads the year boundary in the business zone', () => {
    expect(noteWhen(NEW_YEARS_EVE_CHICAGO.getTime(), CHICAGO, NOW_2026)).toBe('Dec 31, 11:30 PM');
    expect(noteWhen(NEW_YEAR_CHICAGO.getTime(), CHICAGO, NOW_2026)).toBe('Jan 1, 2027, 12:30 AM');
  });
  it('formatReminderTime names the year only outside the current year', () => {
    expect(formatReminderTime(Date.parse('2026-09-14T20:05:00Z'), CHICAGO, NOW_2026)).toBe('Sep 14, 3:05 PM');
    expect(formatReminderTime(Date.parse('2025-09-14T20:05:00Z'), CHICAGO, NOW_2026)).toBe('Sep 14, 2025, 3:05 PM');
  });
});
