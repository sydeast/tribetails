import { formatClockDuration, formatMiles } from '@tribetails/geo';

/**
 * The dark strip that sits over the Kin Care route map (#760).
 *
 * Operator ruling, 2026-09-11, quoting the previous system's visit report:
 * "this is what the map looks like and is usually listed under the arrival
 * departure times". The strip in that report reads
 *
 *     Completed in 1:04 | Arrived at 12:05pm - Departed at 1:09pm - 0.1 miles
 *
 * with the visit's age at the right-hand end.
 *
 * ONE LABEL IS DELIBERATELY NOT THE REFERENCE'S. The old report writes
 * "Completed at" over what this system stores as `departedAt`, and this screen
 * must not. `SessionDetail.tsx` carries the ruling in full: departing is the
 * Auntie leaving the house, completing is the office ruling the visit happened
 * and is billable, `transitionBookingStatus` can stamp the second without the
 * first, and labelling one as the other is a defect that was already fixed once
 * on this exact screen. A strip reading "Completed at 1:09pm" two panels below
 * a Timing row reading "Completed 3:00pm" would be the same screen stating two
 * different completion times, one of them invented. So the clause names the
 * event it actually holds. "Completed in", the duration, is kept verbatim: it
 * is how long the visit ran and it claims nothing about which field stamped it.
 *
 * Pure, and separate from the component, so the wording can be read off a test
 * rather than off a rendered map nothing in CI can draw.
 */

export interface RouteHeaderStrip {
  /** "Completed in 1:04". `''` when the visit has no measurable length. */
  lead: string;
  /**
   * "Arrived at 12:05pm - Departed at 1:09pm - 0.1 miles", with any clause
   * whose fact is missing left out rather than printed blank. `''` when none of
   * the three is known.
   */
  detail: string;
  /** "1 month ago". `''` when there is no usable date to measure from. */
  age: string;
}

export interface RouteHeaderInput {
  /** `kin_care_sessions.arrivedAt`, an ISO instant, or `''`. */
  arrivedAt?: string | undefined;
  /** `kin_care_sessions.departedAt`, an ISO instant, or `''`. */
  departedAt?: string | undefined;
  /** Metres, from `gpsSummary.distanceMeters` or the breadcrumbs. */
  distanceMeters?: number | undefined;
  /** Seconds. Falls back to the gap between the two stamps above. */
  durationSeconds?: number | undefined;
  /** Injected so the age is testable; defaults to now. */
  now?: Date;
}

/** A parsed ISO instant, or null for blank and unparseable input. */
function instant(iso: string | undefined): Date | null {
  const trimmed = (iso ?? '').trim();
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * LOCAL `h:mma`, the reference report's shape: "12:05pm", "9:01am".
 *
 * Local, not UTC, for the AO-18 reason `lib/time.ts` states: the operator's
 * clock is their wall clock, and a UTC slice would print every afternoon visit
 * five hours off.
 */
export function clockTime(iso: string | undefined): string {
  const d = instant(iso);
  if (!d) return '';
  const h24 = d.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}${h24 < 12 ? 'am' : 'pm'}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 days" / "1 month", pluralized, for a whole-number count of a unit. */
function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * How long ago something happened, in the coarsest unit that still says
 * something: "just now", "12 minutes ago", "3 hours ago", "6 days ago",
 * "1 month ago", "2 years ago".
 *
 * COARSE ON PURPOSE. The precise instant is already on this screen, twice: the
 * Timing panel prints it and the strip's own middle clause prints the clock
 * time. What this line answers is the one thing those do not, which is whether
 * the operator is looking at this morning's visit or at one from the spring.
 *
 * Months are counted at 30 days and years at 365. Neither is a calendar, and
 * neither needs to be: a label that says "1 month ago" is not being read for
 * the day it lands on.
 *
 * A FUTURE instant returns `''` rather than a negative age. A scheduled visit
 * has no route to draw, so a future stamp here is a clock skew or a bad
 * document, and "in -3 days" is not a fact worth printing over a map.
 */
export function relativeAge(iso: string | undefined, now: Date = new Date()): string {
  const d = instant(iso);
  if (!d) return '';
  const ms = now.getTime() - d.getTime();
  if (ms < 0) return '';
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${plural(Math.floor(ms / MINUTE), 'minute')} ago`;
  if (ms < DAY) return `${plural(Math.floor(ms / HOUR), 'hour')} ago`;
  const days = Math.floor(ms / DAY);
  if (days < 30) return `${plural(days, 'day')} ago`;
  if (days < 365) return `${plural(Math.floor(days / 30), 'month')} ago`;
  return `${plural(Math.floor(days / 365), 'year')} ago`;
}

/**
 * The three pieces of the strip, ready to render.
 *
 * The visit length prefers the stored `gpsSummary.durationSeconds` and falls
 * back to the gap between the two stamps, because a visit can carry honest
 * arrival and departure times with no GPS summary at all (breadcrumbs off, or
 * purged past the retention window) and the office still wants to know it ran
 * an hour.
 *
 * A VISIT STILL IN FLIGHT GETS NO LENGTH AT ALL, whatever number the caller
 * passes. RouteMap hands this `durationFromPoints(route)` when the session has
 * no `gpsSummary`, which on an ARRIVED visit is the span of the breadcrumbs so
 * far, and printing "Completed in 0:07" over a walk the Auntie is in the middle
 * of would be this screen stating a completion that has not happened. The
 * departure stamp is the gate: `gpsSummary.durationSeconds` is only baked at
 * DEPARTED anyway, so a finished visit loses nothing.
 */
export function routeHeaderStrip(input: RouteHeaderInput): RouteHeaderStrip {
  const arrived = instant(input.arrivedAt);
  const departed = instant(input.departedAt);

  const spanSeconds =
    arrived && departed ? Math.max(0, Math.round((departed.getTime() - arrived.getTime()) / 1000)) : 0;
  const seconds = input.durationSeconds !== undefined && input.durationSeconds > 0 ? input.durationSeconds : spanSeconds;
  const clock = departed === null ? '' : formatClockDuration(seconds);

  const clauses: string[] = [];
  const arrivedClock = clockTime(input.arrivedAt);
  if (arrivedClock !== '') clauses.push(`Arrived at ${arrivedClock}`);
  const departedClock = clockTime(input.departedAt);
  if (departedClock !== '') clauses.push(`Departed at ${departedClock}`);
  if (input.distanceMeters !== undefined && Number.isFinite(input.distanceMeters)) {
    clauses.push(formatMiles(input.distanceMeters));
  }

  return {
    lead: clock === '' ? '' : `Completed in ${clock}`,
    detail: clauses.join(' - '),
    // Measured from the END of the visit where there is one, and from the
    // arrival where there is not. A visit in flight therefore ages from when
    // the Auntie clocked in, which is the honest reading of "how old is what I
    // am looking at" and is also how long she has been at the house.
    age: relativeAge(input.departedAt ?? '', input.now) || relativeAge(input.arrivedAt ?? '', input.now),
  };
}
