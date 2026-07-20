import type { Timestamp } from 'firebase/firestore';

/**
 * Pure booking classification + display helpers, kept out of the screen so the
 * mapping logic has direct vitest coverage (the invoiceFormat.ts / directory.ts
 * convention).
 *
 * `status` on a `kin_care_sessions` doc is free-text and, unlike `invoices`, is
 * written DIRECTLY by the admin client via the Firestore SDK, not only by a
 * Cloud Function: firestore.rules:203-209 grants `isAuntie()` unmediated
 * create/update/delete on this collection. The five recognized values below
 * are read straight off the wasm reference:
 *   - DRAFT / PENDING   the two outcomes BookingCreateScreen's "Save draft" /
 *                       "Submit request" buttons write (BookingScreen.kt:996,
 *                       1014).
 *   - SCHEDULED         createKinCareSession.ts's and
 *                       approveBookingSeriesCore.ts's default status for a
 *                       newly-created or newly-approved session.
 *   - COMPLETED         set by the admin's KinCareSessionsScreen "Mark
 *                       Completed" action (KinCareSessionsScreen.kt:716).
 *   - CANCELLED         set by the same screen's Cancel action
 *                       (KinCareSessionsScreen.kt:724). BookingScreen.kt's own
 *                       `CANCELLED_STATUSES` set also tolerates the "CANCELED"
 *                       spelling and a MyTribe-side "REJECTED"; folded into
 *                       one bucket here, same as there.
 *
 * Every branch is a POSITIVE read of the (trimmed, uppercased) status text.
 * Nothing here falls through to a state by elimination: an unrecognized or
 * blank status lands in its own named `unknown` bucket rather than being
 * silently absorbed into whichever state happens to be checked last, the
 * AO-12 class of bug invoiceFormat.ts's `invoiceState` was written to retire,
 * applied here before this screen ever ships a first version.
 */
export type BookingState = 'draft' | 'pending' | 'scheduled' | 'completed' | 'cancelled' | 'unknown';

export interface BookingStateInput {
  status: string;
}

/** Ports BookingScreen.kt's `CANCELLED_STATUSES` verbatim. */
const CANCELLED_STATUSES = new Set(['CANCELLED', 'CANCELED', 'REJECTED']);

export function bookingState(row: BookingStateInput): BookingState {
  const status = row.status.trim().toUpperCase();
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
  const s = raw.trim();
  if (s === '') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
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
export interface BookingWhenInput {
  startTime: string;
  completedAt: string;
  departedAt: string;
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
  const raw = row.startTime.trim() || row.completedAt.trim() || row.departedAt.trim();
  if (raw !== '') {
    const parsed = parseFlexibleDate(raw);
    return parsed ? formatLocalDateTime(parsed) : raw;
  }
  if (row.createdAt) return formatLocalDateTime(row.createdAt.toDate());
  return 'Date pending';
}
