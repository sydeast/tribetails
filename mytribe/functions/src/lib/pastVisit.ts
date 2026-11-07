import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';
import { BUSINESS_SETTINGS_DOC, zonedNow } from './businessHours';
import { businessTimeZone } from './bookingTimeBlocks';

/**
 * ISSUE #1574: WHEN A VISIT'S WINDOW MAY BE IN THE PAST.
 *
 * The walk created a visit on 11/01/2025 and it saved as SCHEDULED, then moved
 * another visit to the same day with "Dre East's visit is rescheduled." Nothing
 * on the server compared a window with the clock.
 *
 * Operator ruling, 2026-11-05 docket: past-dated visits are "allowed only as
 * already completed. A visit created with a past date goes straight to
 * Completed, never Scheduled." Moving an existing visit into the past stays
 * blocked: the ruling covers writing down a visit that already happened, not
 * rewriting when a booked one happens.
 *
 * So there are three windows, judged on the server's clock:
 *
 *   ahead     the start has not come yet            may be SCHEDULED
 *   ended     the end has already passed            may only be recorded COMPLETED
 *   underway  started, not yet over                 neither; refused both ways
 *
 * `underway` is refused rather than guessed at. A visit going on right now is
 * either one the office should have booked a moment ago (pick a start still
 * ahead) or one it is writing down early (wait until it ends), and saying which
 * is the operator's call, not this function's.
 *
 * A ZONE-LESS TIME IS READ ON THE BUSINESS CLOCK. The web and desktop send
 * UTC-suffixed ISO; Android's reschedule sends a zone-less wall clock
 * (`2026-11-06T20:00:00`), which `Date.parse` would read on the SERVER's clock
 * (UTC) and so call a move to 8 PM Chicago "past" from 2 PM onward. A zone-less
 * string is therefore compared with the business's own wall clock
 * (`business_settings.timeZone`), read only when such a string arrives.
 *
 * The clients hold the same three-way split (web `lib/pastVisit.ts`, Android
 * `domain/PastVisit.kt`, desktop `screens/schedule/PastVisit.kt`) so the form
 * says which case it is before anything is sent. These sentences are the ones
 * they show; client tests read this file to keep the wording identical.
 */

export type VisitWindowTiming = 'ahead' | 'ended' | 'underway';

export const VISIT_IN_PAST_CODE = 'visit_in_past';
export const VISIT_UNDERWAY_CODE = 'visit_underway';
export const COMPLETED_NOT_OVER_CODE = 'completed_visit_not_over';
export const RESCHEDULE_IN_PAST_CODE = 'reschedule_in_past';

export const VISIT_IN_PAST_MESSAGE =
  'That time has already passed. A visit in the past can only be recorded as completed.';
export const VISIT_UNDERWAY_MESSAGE =
  'That visit would already be under way. Pick a start still ahead to schedule it, or record it as completed once it has ended.';
export const COMPLETED_NOT_OVER_MESSAGE =
  'That visit has not happened yet, so it cannot be recorded as completed. Schedule it instead.';
export const RESCHEDULE_IN_PAST_MESSAGE =
  'That time has already passed. A visit can only be moved to a time still ahead.';
export const RESCHEDULE_ASK_PASSED_MESSAGE =
  'The time this household asked for has already passed. Decline the ask, then move the visit to a time still ahead.';

/**
 * Which of the three windows `[startMs, endMs)` is at `nowMs`. A start exactly
 * at now counts as ahead (the visit has not begun), an end exactly at now as
 * ended. An end that is missing or not after the start is treated as the start
 * itself, so a zero-length window is never `underway`.
 */
export function classifyVisitWindow(startMs: number, endMs: number, nowMs: number): VisitWindowTiming {
  if (startMs >= nowMs) return 'ahead';
  const end = Number.isFinite(endMs) && endMs > startMs ? endMs : startMs;
  return end <= nowMs ? 'ended' : 'underway';
}

/** Resolves the business zone once, on first use. */
export type TimeZoneReader = () => Promise<string>;

/** `business_settings.timeZone` (or the shared fallback), read at most once per call site. */
export function businessTimeZoneReader(): TimeZoneReader {
  let pending: Promise<string> | null = null;
  return () => {
    pending ??= db()
      .doc(BUSINESS_SETTINGS_DOC)
      .get()
      .then((snap) => businessTimeZone(snap.exists ? snap.data() : undefined));
    return pending;
  };
}

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/**
 * A stored or sent time as something comparable with now: epoch ms for an
 * instant, or `YYYY-MM-DDTHH:mm` on the business clock for a zone-less wall
 * clock, with now rendered the same way. Null when the string is neither.
 */
async function comparable(
  raw: string,
  nowMs: number,
  timeZone: TimeZoneReader,
): Promise<{ value: number | string; now: number | string } | null> {
  const s = raw.trim();
  const wall = WALL_CLOCK.exec(s);
  if (wall) {
    const zoned = zonedNow(nowMs, await timeZone());
    if (zoned === null) return null;
    return { value: `${wall[1]}T${wall[2]}`, now: `${zoned.dateIso}T${zoned.timeHHmm}` };
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? { value: ms, now: nowMs } : null;
}

/** Below zero: before now. Zero: this minute (or instant). Above: after. Null: unreadable. */
async function versusNow(raw: string, nowMs: number, timeZone: TimeZoneReader): Promise<number | null> {
  const c = await comparable(raw, nowMs, timeZone);
  if (c === null) return null;
  if (c.value === c.now) return 0;
  return c.value < c.now ? -1 : 1;
}

/**
 * `classifyVisitWindow` for the strings a callable receives. Null when the
 * start cannot be read: the caller's own validation decides what that means,
 * and this never invents a timing for a time it cannot read.
 */
export async function classifyVisitTimes(
  startTime: string,
  endTime: string,
  nowMs: number,
  timeZone: TimeZoneReader,
): Promise<VisitWindowTiming | null> {
  const start = await versusNow(startTime, nowMs, timeZone);
  if (start === null) return null;
  if (start >= 0) return 'ahead';
  const end = await versusNow(endTime, nowMs, timeZone);
  // An unreadable end reads as the start, which has passed.
  return end === null || end <= 0 ? 'ended' : 'underway';
}

/**
 * `createKinCareSession`'s gate. Returns the status the visit is written with,
 * or throws the refusal the client shows word for word.
 */
export async function newVisitStatusFor(args: {
  startTime: string;
  endTime: string;
  nowMs: number;
  recordAsCompleted: boolean;
  timeZone: TimeZoneReader;
}): Promise<'SCHEDULED' | 'COMPLETED'> {
  const timing = await classifyVisitTimes(args.startTime, args.endTime, args.nowMs, args.timeZone);
  if (timing === null) return 'SCHEDULED';
  if (timing === 'underway') {
    throw new HttpsError('failed-precondition', VISIT_UNDERWAY_MESSAGE, { code: VISIT_UNDERWAY_CODE });
  }
  if (timing === 'ended') {
    if (!args.recordAsCompleted) {
      throw new HttpsError('failed-precondition', VISIT_IN_PAST_MESSAGE, { code: VISIT_IN_PAST_CODE });
    }
    return 'COMPLETED';
  }
  if (args.recordAsCompleted) {
    throw new HttpsError('failed-precondition', COMPLETED_NOT_OVER_MESSAGE, { code: COMPLETED_NOT_OVER_CODE });
  }
  return 'SCHEDULED';
}

/**
 * `rescheduleBooking`'s gate (Schedule drag, detail sheet, Bookings, bulk, and
 * Android's moves): the new start must still be ahead. The accept branch of
 * `resolveBookingRescheduleRequest` holds a Timestamp and checks it directly;
 * the portal's own `requestBookingReschedule` refuses a past proposal when it
 * is made.
 */
export async function assertRescheduleStartAhead(
  startTime: string,
  nowMs: number,
  timeZone: TimeZoneReader,
): Promise<void> {
  const start = await versusNow(startTime, nowMs, timeZone);
  if (start !== null && start < 0) {
    throw new HttpsError('failed-precondition', RESCHEDULE_IN_PAST_MESSAGE, { code: RESCHEDULE_IN_PAST_CODE });
  }
}
