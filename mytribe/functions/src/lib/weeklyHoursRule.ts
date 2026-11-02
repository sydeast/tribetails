import { HttpsError } from 'firebase-functions/v2/https';

import {
  businessHoursForDayName,
  hasSpecialHours,
  resolveBusinessOpen,
  weekdayNameOfDate,
  type BusinessHoursSettings,
} from './businessHours';
import type { BookingPolicy } from './bookingTimeBlocks';

/**
 * #1284 / #1382: the weekly business-hours rule, shared by every path that
 * takes a household's proposed time (`requestBooking`, `requestBookingReschedule`)
 * so the two can never disagree about what the office is open for.
 *
 * Judged in the business's own zone with `resolveBusinessOpen`, the phone
 * line's resolver. A closed weekday is refused in either booking mode; a clock
 * time outside the day's hours is refused only when the visit books by clock.
 * A time block is the operator's own statement of when visits happen, and a
 * start-time service (an overnight) has its start set by the operator, so
 * neither is second-guessed against the weekly hours.
 *
 * #1406 (ruling on #1301: block every type): a night awaiting its start
 * (#1098) has a date and no instant, so it is judged by its date alone. A
 * night on a weekday with no hours at all is refused with the closed-day
 * sentence; a night on an open day gets no clock check, since there is no
 * clock to check until the operator sets the start. The predicate is the one
 * `getBusinessClosures` greys the day picker with, so the server never refuses
 * a night the calendar offered.
 *
 * Fail-open where the configuration is unreadable: no `businessHours` map, an
 * unreadable hours string, a dated `specialHours` entry, an unusable zone, or
 * a settings read that failed (callers pass `null`) never refuses a household.
 */

/** `business_settings.businessHours`, as the Settings screen writes it. */
export function hoursAreConfigured(raw: Record<string, unknown>): boolean {
  const map = raw['businessHours'];
  return !!map && typeof map === 'object' && Object.keys(map as Record<string, unknown>).length > 0;
}

export interface WeeklyHoursCandidate {
  startTimeMs: number;
  /** The block the booking resolved to; null when it books by clock time. */
  timeBlockId: string | null;
  serviceId?: string | undefined;
}

/** #1406: a night awaiting its start (#1098), known only by its business-local date. */
export interface WeeklyHoursNightCandidate {
  /** `YYYY-MM-DD` in the business's zone; `planVisit` has already checked it is a real date. */
  requestedDate: string;
  serviceId?: string | undefined;
}

/** The closed-day sentence, shared by the instant and the date paths so they cannot drift. */
function closedDaySentence(dayName: string): string {
  return `We are closed on ${dayName}s. Pick another day for this visit.`;
}

/**
 * The refusal sentence for a night, or null when its date is allowed (or the
 * hours cannot be read). Mirrors `getBusinessClosures`'s weekly closed days:
 * a weekday is closed only when its key is PRESENT in `businessHours` and
 * blank, the way Settings writes "Closed". A missing key, an unreadable value
 * or a dated `specialHours` entry closes nothing. Company holidays are the
 * holiday guard's job, as on the instant path.
 */
export function weeklyHoursRefusalForNight(
  raw: Record<string, unknown> | null,
  candidate: WeeklyHoursNightCandidate,
): string | null {
  if (raw === null || !hoursAreConfigured(raw)) return null;
  const dayName = weekdayNameOfDate(candidate.requestedDate);
  if (dayName === null) return null;
  const map = raw['businessHours'] as Record<string, unknown>;
  if (!(dayName in map)) return null;
  if (hasSpecialHours(raw['specialHours'], candidate.requestedDate)) return null;
  if (businessHoursForDayName(map, dayName).kind !== 'closed') return null;
  return closedDaySentence(dayName);
}

/**
 * The refusal sentence for one visit, or null when the time is allowed (or the
 * hours cannot be read). `raw` is the settings document, null when missing or
 * unreadable.
 */
export function weeklyHoursRefusal(
  raw: Record<string, unknown> | null,
  timeZone: string,
  policy: Pick<BookingPolicy, 'startTimeServiceIds'>,
  candidate: WeeklyHoursCandidate,
): string | null {
  if (raw === null || !hoursAreConfigured(raw)) return null;

  const hoursSettings: BusinessHoursSettings = {
    businessHours: raw['businessHours'],
    // The resolved zone, not the raw field: a blank one means the ruled
    // America/Chicago (#1109), never a silent UTC.
    timeZone,
    companyHolidays: raw['companyHolidays'],
    specialHours: raw['specialHours'],
  };

  const state = resolveBusinessOpen(hoursSettings, candidate.startTimeMs);
  if (state.reason === 'closed-day') {
    return closedDaySentence(state.dayName);
  }

  const booksByClock =
    candidate.timeBlockId === null &&
    !(candidate.serviceId !== undefined && policy.startTimeServiceIds.includes(candidate.serviceId));
  if (booksByClock && state.reason === 'outside-hours') {
    const hours = businessHoursForDayName(raw['businessHours'], state.dayName);
    const range = hours.kind === 'open' ? ` (${hours.startHHmm} to ${hours.endHHmm})` : '';
    return `That time is outside our hours on ${state.dayName}s${range}. Pick a time inside them.`;
  }

  return null;
}

/** Throws `invalid-argument` with {@link weeklyHoursRefusal}'s sentence. */
export function assertWeeklyHours(
  raw: Record<string, unknown> | null,
  timeZone: string,
  policy: Pick<BookingPolicy, 'startTimeServiceIds'>,
  candidate: WeeklyHoursCandidate,
): void {
  const message = weeklyHoursRefusal(raw, timeZone, policy, candidate);
  if (message !== null) throw new HttpsError('invalid-argument', message);
}

/** A visit of a series: timed (an instant) or a night awaiting its start (a date). */
export type WeeklyHoursVisit = WeeklyHoursCandidate | WeeklyHoursNightCandidate;

function isNight(v: WeeklyHoursVisit): v is WeeklyHoursNightCandidate {
  return 'requestedDate' in v;
}

/**
 * A request that carries several visits (a series): every visit is checked,
 * earliest first, and the request is refused naming the first bad date. A
 * single visit gets the plain sentence with no date.
 *
 * #1406: a night (#1098) is checked by its date, see `weeklyHoursRefusalForNight`.
 * "Earliest" is by business-local date, then by start within the day, so a
 * night sorts with the timed visits of its own day.
 */
export function assertWeeklyHoursForVisits(
  raw: Record<string, unknown> | null,
  timeZone: string,
  policy: Pick<BookingPolicy, 'startTimeServiceIds'>,
  visits: ReadonlyArray<WeeklyHoursVisit>,
): void {
  const dateOf = (v: WeeklyHoursVisit): string =>
    isNight(v)
      ? v.requestedDate
      : resolveBusinessOpen({ businessHours: raw?.['businessHours'], timeZone }, v.startTimeMs).localDateIso;
  const ordered = visits
    .map((v) => ({ v, date: dateOf(v), startTimeMs: isNight(v) ? 0 : v.startTimeMs }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.startTimeMs - b.startTimeMs));
  for (const { v, date } of ordered) {
    const message = isNight(v) ? weeklyHoursRefusalForNight(raw, v) : weeklyHoursRefusal(raw, timeZone, policy, v);
    if (message === null) continue;
    if (visits.length === 1) throw new HttpsError('invalid-argument', message);
    throw new HttpsError('invalid-argument', `${date}: ${message}`);
  }
}
