import type { Timestamp } from 'firebase/firestore';
import { str } from './coerce';

/**
 * Pure booking classification + display helpers, kept out of the screen so the
 * mapping logic has direct vitest coverage (the invoiceFormat.ts / directory.ts
 * convention).
 *
 * `status` on a `kin_care_sessions` doc is free-text, and this file only READS
 * it. WHO MAY WRITE IT CHANGED IN A3, so the old note here ("written directly
 * by the admin client, firestore.rules grants isAuntie() unmediated
 * create/update/delete") no longer describes the collection:
 *
 *   - The two TERMINAL values, COMPLETED and CANCELLED, are now written only by
 *     the `transitionBookingStatus` callable. `firestore.rules` refuses them
 *     from every client, so no browser or phone can set either one.
 *   - The in-visit lifecycle (ON_MY_WAY / ARRIVED / DEPARTED, and Undo Arrival
 *     back to SCHEDULED) is still a direct client patch from the field app.
 *
 * The five values this classifier recognizes are unchanged, and this file is
 * unaffected by the move: a status is a status however it got written. They are
 * read straight off the wasm reference:
 *   - DRAFT / PENDING   the two outcomes BookingCreateScreen's "Save draft" /
 *                       "Submit request" buttons write (BookingScreen.kt:996,
 *                       1014).
 *   - SCHEDULED         createKinCareSession.ts's and
 *                       approveBookingSeriesCore.ts's default status for a
 *                       newly-created or newly-approved session.
 *   - COMPLETED         the COMPLETE transition (was KinCareSessionsScreen.kt's
 *                       "Mark Completed" patch, KinCareSessionsScreen.kt:716).
 *   - CANCELLED         the CANCEL and REJECT transitions, which land on one
 *                       stored value (was the same screen's Cancel action,
 *                       KinCareSessionsScreen.kt:724). BookingScreen.kt's own
 *                       `CANCELLED_STATUSES` set also tolerates the "CANCELED"
 *                       spelling and a MyTribe-side "REJECTED"; folded into
 *                       one bucket here, same as there, and the server's state
 *                       machine folds the same three on read.
 *
 * Every branch is a POSITIVE read of the (trimmed, uppercased) status text.
 * Nothing here falls through to a state by elimination: an unrecognized or
 * blank status lands in its own named `unknown` bucket rather than being
 * silently absorbed into whichever state happens to be checked last, the
 * AO-12 class of bug the Invoice State Classifier was written to retire (that
 * classifier lives server-side now, `mytribe/functions/src/lib/invoiceEditPolicy.ts`,
 * per ADR-0002), applied here before this screen ever ships a first version.
 */
export type BookingState = 'draft' | 'pending' | 'scheduled' | 'completed' | 'cancelled' | 'unknown';

export interface BookingStateInput {
  /** Optional: a real kin_care_sessions doc can omit `status` entirely.
   *  `| undefined` is required by this repo's `exactOptionalPropertyTypes`. */
  status?: string | undefined;
}

/** Ports BookingScreen.kt's `CANCELLED_STATUSES` verbatim. */
const CANCELLED_STATUSES = new Set(['CANCELLED', 'CANCELED', 'REJECTED']);

export function bookingState(row: BookingStateInput): BookingState {
  // str(): a real kin_care_sessions doc can lack `status` entirely. Reading it
  // blind blanked the whole Bookings page via the error boundary (2026-07-20).
  const status = str(row.status).trim().toUpperCase();
  if (status === 'DRAFT') return 'draft';
  if (status === 'PENDING') return 'pending';
  if (status === 'SCHEDULED') return 'scheduled';
  if (status === 'COMPLETED') return 'completed';
  if (CANCELLED_STATUSES.has(status)) return 'cancelled';
  return 'unknown';
}

export interface BookingStateInfo {
  /** Friendly label for the row/detail chip. */
  label: string;
  /** Uppercased chip text. */
  chipLabel: string;
  /** CSS class suffix for `.bookings__chip--<cssClass>`. */
  cssClass: string;
}

/** Friendly label + chip class per enumerated state. Pure 1:1 map, no fallback branch. */
export function bookingStateInfo(state: BookingState): BookingStateInfo {
  switch (state) {
    case 'draft':
      return { label: 'Draft', chipLabel: 'DRAFT', cssClass: 'draft' };
    case 'pending':
      return { label: 'Pending', chipLabel: 'PENDING', cssClass: 'pending' };
    case 'scheduled':
      return { label: 'Scheduled', chipLabel: 'SCHEDULED', cssClass: 'scheduled' };
    case 'completed':
      return { label: 'Completed', chipLabel: 'COMPLETED', cssClass: 'completed' };
    case 'cancelled':
      return { label: 'Cancelled', chipLabel: 'CANCELLED', cssClass: 'cancelled' };
    case 'unknown':
      return { label: 'Unknown', chipLabel: 'UNKNOWN', cssClass: 'unknown' };
  }
}

/**
 * Two-letter monogram for the row avatar. Ports `initialsFor` in
 * BookingScreen.kt exactly: first+last word initials, or the first two
 * letters of a single word, or "?" for a blank name.
 */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p !== '');
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Parses a stored booking timestamp STRING (not a Firestore Timestamp, see
 * `BookingWhenInput`'s doc). `kin_care_sessions.startTime` /`.completedAt` /
 * `.departedAt` are opaque strings, usually either a real UTC instant from
 * `Date.toISOString()` (approveBookingSeriesCore.ts's `toIso()`) or a
 * local-wall-clock string with no offset, `${date}T${time}:00`
 * (`buildSession` in BookingScreen.kt). `new Date(...)` parses both correctly
 * per the ISO 8601 grammar: a date-time form with no timezone designator reads
 * as LOCAL time, not UTC. Returns null (never a fabricated date) when the
 * string is blank or genuinely unparseable.
 */
export function parseFlexibleDate(raw: string): Date | null {
  const s = str(raw).trim();
  if (s === '') return null;

  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime())) return direct;

  // The format the migration actually wrote, which `new Date()` rejects
  // outright: "September 3, 2025 2:02pm". The meridiem is lowercase and has no
  // separating space, and JS requires "2:02 PM". This is not an edge case, it is
  // the MAJORITY of the data: 83 of 92 kin_care_reports and 14 kin_care_session
  // date strings. Every one displayed "Date TBD" while the real date sat in the
  // document (verified live 2026-07-20).
  //
  // Only the meridiem is normalised; the rest of the string is handed to Date
  // unchanged, so nothing is invented. A string with no parseable date at all
  // (the bare `departedAt: "6pm"` that exists in kin_care_sessions) still
  // returns null rather than being anchored to an arbitrary day.
  const normalised = s.replace(/(\d)\s*([ap])\.?\s*m\.?\b/i, (_m, digit: string, ap: string) =>
    `${digit} ${ap.toUpperCase()}M`,
  );
  if (normalised !== s) {
    const retry = new Date(normalised);
    if (!Number.isNaN(retry.getTime())) return retry;
  }
  return null;
}

/**
 * "Jul 16, 9:00 AM" in the LOCAL zone. Uses `Date`'s local getters
 * (getMonth/getDate/getHours/getMinutes), never `toISOString()`, the same
 * AO-18 discipline lib/time.ts applies to real Firestore Timestamps, applied
 * here to this collection's free-text timestamp-shaped strings.
 */
export function formatLocalDateTime(d: Date): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = names[d.getMonth()] ?? '';
  const day = d.getDate();
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${month} ${day}, ${hours}:${pad(d.getMinutes())} ${ampm}`;
}

/**
 * What `bookingWhen` needs. `createdAt` IS a real Firestore Timestamp
 * (`FieldValue.serverTimestamp()`, stamped by both createKinCareSession.ts and
 * approveBookingSeriesCore.ts), the one genuinely reliable moment on this
 * doc, and the field BOOKINGS_QUERY sorts by (see api/bookings.ts).
 */
/** Optional for the same reason as BookingEntry: these are raw Firestore values
 *  and the documents really do omit them. `str()` handles it at each read. */
export interface BookingWhenInput {
  startTime?: string | undefined;
  completedAt?: string | undefined;
  departedAt?: string | undefined;
  createdAt: Timestamp | null;
}

/**
 * The row's "when" line. Prefers the visit's own `startTime`, falling back
 * through `completedAt` / `departedAt`, mirrors `bookingDateLabel` in
 * BookingScreen.kt, written for the same reason: a legacy/imported session can
 * have a blank `startTime` while still carrying a real completion or
 * departure stamp. Only once all three are blank does this fall back to
 * `createdAt`, the one field on this doc that is a genuine server timestamp.
 *
 * A raw value that fails to parse is shown verbatim rather than hidden
 * (fail-loud, matching invoiceFormat.ts's `humanizeDate`); a doc with nothing
 * parseable anywhere says so honestly ("Date pending") instead of fabricating
 * one.
 */
export function bookingWhen(row: BookingWhenInput): string {
  const raw = str(row.startTime).trim() || str(row.completedAt).trim() || str(row.departedAt).trim();
  if (raw !== '') {
    const parsed = parseFlexibleDate(raw);
    return parsed ? formatLocalDateTime(parsed) : raw;
  }
  if (row.createdAt) return formatLocalDateTime(row.createdAt.toDate());
  return 'Date pending';
}
