import { HttpsError } from 'firebase-functions/v2/https';

import {
  businessHoursForDayName,
  resolveBusinessOpen,
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
    return `We are closed on ${state.dayName}s. Pick another day for this visit.`;
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

/**
 * A request that carries several visits (a series): every visit is checked,
 * earliest first, and the request is refused naming the first bad date. A
 * single visit gets the plain sentence with no date.
 */
export function assertWeeklyHoursForVisits(
  raw: Record<string, unknown> | null,
  timeZone: string,
  policy: Pick<BookingPolicy, 'startTimeServiceIds'>,
  visits: ReadonlyArray<WeeklyHoursCandidate>,
): void {
  const ordered = [...visits].sort((a, b) => a.startTimeMs - b.startTimeMs);
  for (const v of ordered) {
    const message = weeklyHoursRefusal(raw, timeZone, policy, v);
    if (message === null) continue;
    if (visits.length === 1) throw new HttpsError('invalid-argument', message);
    const date = resolveBusinessOpen(
      { businessHours: raw?.['businessHours'], timeZone },
      v.startTimeMs,
    ).localDateIso;
    throw new HttpsError('invalid-argument', `${date}: ${message}`);
  }
}
