import type { RescheduleBookingArgs } from '../contracts/bookingContracts.generated';

/**
 * Pure display + arithmetic helpers for the Schedule booking detail sheet
 * (`components/BookingDetailModal.tsx`), kept out of the component so the
 * cutoff rule and the reschedule maths have direct vitest coverage (the
 * `sessionFormat.ts` / `invoiceFormat.ts` convention).
 *
 * ── AO-18 applies to every function here ──────────────────────────────────
 * `kin_care_sessions.startTime`/`endTime` are free-text ISO instant strings,
 * and the real writer (`approveBookingSeriesCore.ts#toIso`) stamps them
 * UTC-suffixed ("...Z"). The archive's `BookingDetailModal.kt` prefilled its
 * reschedule fields by SLICING those characters (`iso.substring(0, 10)`,
 * `iso.substring(11, 16)`), which shows an operator in Chicago the UTC hour:
 * a 20:00 local visit prefills as "01:00" on the following day. Every helper
 * below parses to a real instant first and reads it back through the LOCAL
 * getters, so what the operator sees and edits is their own wall clock.
 */

/**
 * How long before a visit starts the note composers lock, in milliseconds.
 *
 * A MIRROR OF THE SERVER RULE, not the rule itself. Both note callables
 * enforce this window in `mytribe/functions/src/lib/bookingNoteCutoff.ts` and
 * reject with `failed-precondition` + `details.code === 'booking_note_cutoff'`.
 * The lock this constant drives exists so the operator sees a closed composer
 * instead of typing a note and being refused.
 *
 * ONE constant on this side too, deliberately. Two literals in two places is
 * how a client and a server drift into disagreeing about whether a note is
 * allowed, which reads to an operator as a button that does nothing. Change it
 * only alongside the server's, which `test/callableContract.test.ts` freezes.
 */
export const NOTE_CUTOFF_MS = 3 * 60 * 60 * 1000;

/** Visit length assumed when nothing on the doc says otherwise. Matches the
 *  archive's own reschedule fallback and android's `buildRescheduleTimes`. */
export const DEFAULT_VISIT_MINUTES = 30;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{2}:\d{2}$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** A real `Date` for a free-text ISO field, or null. Never throws, never guesses. */
function parseInstant(iso: string): Date | null {
  const trimmed = (iso ?? '').trim();
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * True once the visit is within [NOTE_CUTOFF_MS] of starting (or has already
 * started). A session with no parseable start is NOT locked: there is no
 * window to be inside of, and the server is the real gate on the
 * kinfolk-facing side either way, so guessing "locked" would block a note the
 * backend would have accepted.
 */
export function notesLocked(startIso: string, nowMs: number): boolean {
  const start = parseInstant(startIso);
  if (start === null) return false;
  return nowMs >= start.getTime() - NOTE_CUTOFF_MS;
}

/** The copy shown beside a locked composer. Says WHY, rather than leaving the
 *  operator with a grey control and no explanation. */
export function noteLockReason(): string {
  return 'Notes are locked: this visit starts in under 3 hours.';
}

/** LOCAL `YYYY-MM-DD` for an `<input type="date">` prefill, or '' when unknown. */
export function localDateInput(iso: string): string {
  const d = parseInstant(iso);
  if (d === null) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** LOCAL `HH:mm` for an `<input type="time">` prefill, or '' when unknown. */
export function localTimeInput(iso: string): string {
  const d = parseInstant(iso);
  if (d === null) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** The subset of a session doc the duration is derived from. */
export interface DurationSource {
  serviceDurationMinutes?: number | undefined;
  startTime?: string | undefined;
  endTime?: string | undefined;
}

/**
 * Minutes this visit is expected to run. `serviceDurationMinutes` is the field
 * `approveBookingSeriesCore.ts` stamps on every session it creates, so it is
 * preferred; the start/end span covers ad-hoc sessions
 * (`createKinCareSession.ts` does not stamp the duration), and the default
 * covers a doc with neither. An end at or before the start is garbage, not a
 * zero/negative visit, so it falls through to the default too.
 */
export function visitDurationMinutes(source: DurationSource): number {
  const stored = source.serviceDurationMinutes;
  if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) return Math.round(stored);

  const start = parseInstant(source.startTime ?? '');
  const end = parseInstant(source.endTime ?? '');
  if (start !== null && end !== null) {
    const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
    if (minutes > 0) return minutes;
  }
  return DEFAULT_VISIT_MINUTES;
}

/** "1 hr 30 min". `Not recorded` rather than a misleading "0 min". */
export function durationLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Not recorded';
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} hr`;
  return `${hours} hr ${rest} min`;
}

/**
 * The `{startTime, endTime}` pair `rescheduleBooking` writes, aliased off the
 * generated `RescheduleBookingArgs` (contracts/bookingContracts.generated.ts)
 * rather than re-declared, so this stays the same shape the server actually
 * validates.
 */
export type RescheduleTimes = Pick<RescheduleBookingArgs, 'startTime' | 'endTime'>;

/**
 * Build the `{startTime, endTime}` pair `rescheduleBooking` writes, from a
 * LOCAL date + time the operator typed and the visit's own duration.
 *
 * Emits UTC-suffixed ISO, matching what `approveBookingSeriesCore.ts` already
 * writes to this collection, so a rescheduled session sorts and re-parses
 * identically to one that was never touched. (The archive emitted a
 * zone-LESS local string here, which then reads as UTC everywhere downstream:
 * the same AO-18 class of bug, on the write side.)
 *
 * Returns null on anything malformed, including a date that does not exist
 * (2026-02-30) or an out-of-range clock time, so the caller fails loud instead
 * of writing a garbage window to a real household's visit.
 */
export function buildRescheduleTimes(
  date: string,
  time: string,
  durationMinutes: number,
): RescheduleTimes | null {
  if (!ISO_DATE.test(date) || !ISO_TIME.test(time)) return null;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  if (hh > 23 || mm > 59) return null;

  const start = new Date(y, m - 1, d, hh, mm, 0, 0);
  // Round-trip guard: JS silently rolls 2026-02-30 forward into March.
  if (
    start.getFullYear() !== y ||
    start.getMonth() !== m - 1 ||
    start.getDate() !== d ||
    start.getHours() !== hh ||
    start.getMinutes() !== mm
  ) {
    return null;
  }

  const minutes =
    Number.isFinite(durationMinutes) && durationMinutes > 0
      ? Math.round(durationMinutes)
      : DEFAULT_VISIT_MINUTES;
  const end = new Date(start.getTime() + minutes * 60_000);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

/** "Thu, Jul 16 at 2:00 PM", in the operator's LOCAL zone. `Not set` when the
 *  field is blank or unparseable: never a fabricated date. */
export function bookingWhenLabel(iso: string): string {
  const d = parseInstant(iso);
  if (d === null) return 'Not set';
  const hour24 = d.getHours();
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()} at ${hour12}:${pad2(d.getMinutes())} ${meridiem}`;
}
