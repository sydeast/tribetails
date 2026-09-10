import type { Timestamp } from 'firebase/firestore';
import type { TimeBlockDefinition } from '../api/settings';
import { str } from './coerce';
import { resolveTimeBlock } from './businessOperations';
import { serviceDurationMinutes, storedDurationMinutes } from './newBooking';

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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Jul 16" in the LOCAL zone. The date half of {@link formatLocalDateTime}. */
export function formatLocalDate(d: Date): string {
  return `${MONTH_NAMES[d.getMonth()] ?? ''} ${d.getDate()}`;
}

/** "9:00 AM" in the LOCAL zone. The clock half of {@link formatLocalDateTime}. */
export function formatLocalTime(d: Date): string {
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${pad(d.getMinutes())} ${ampm}`;
}

/**
 * "Jul 16, 9:00 AM" in the LOCAL zone. Uses `Date`'s local getters
 * (getMonth/getDate/getHours/getMinutes), never `toISOString()`, the same
 * AO-18 discipline lib/time.ts applies to real Firestore Timestamps, applied
 * here to this collection's free-text timestamp-shaped strings.
 */
export function formatLocalDateTime(d: Date): string {
  return `${formatLocalDate(d)}, ${formatLocalTime(d)}`;
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

/**
 * #699: the millis a row sorts by within its Bookings section, walking the
 * exact same fallback chain `bookingWhen` displays (startTime, then
 * completedAt, then departedAt, then the real `createdAt` server timestamp),
 * so a row never sorts by one moment while showing a different one.
 *
 * `null` when nothing on the row parses to a real instant. Sorting treats
 * `null` as "sorts last" regardless of direction, never as 1970 or "now": an
 * undated row is not the oldest or the newest, it is unknown, and floating it
 * to either end would misplace it next to rows that really do carry that time.
 */
export function bookingSortTimeMs(row: BookingWhenInput): number | null {
  const raw = str(row.startTime).trim() || str(row.completedAt).trim() || str(row.departedAt).trim();
  if (raw !== '') {
    const parsed = parseFlexibleDate(raw);
    if (parsed) return parsed.getTime();
  }
  return row.createdAt ? row.createdAt.toMillis() : null;
}
// ── the row's one meta line ─────────────────────────────────────────────────
/**
 * The operator's own KinCare catalog and booking windows, as far as a booking
 * row needs them. All three come off the single `business_settings` document
 * (`api/settings.ts#getBusinessSettings`), and all three are legitimately
 * empty: nothing here fabricates a name or a window it cannot find.
 */
export interface BookingCatalog {
  /** `business_settings.serviceRates`, keyed by the KinCare id the wizard books with. */
  serviceRates: Record<string, string>;
  /** `business_settings.serviceDurations`, keyed by the same id. Sparse by design. */
  serviceDurations: Record<string, string>;
  /** `business_settings.timeBlocks`, the named windows a kinfolk books into. */
  timeBlocks: readonly TimeBlockDefinition[];
}
/** What a row shows before the settings read lands, and if it never does. */
export const EMPTY_BOOKING_CATALOG: BookingCatalog = {
  serviceRates: {},
  serviceDurations: {},
  timeBlocks: [],
};
/** Letters and digits only, lowercased: "30 Minute", "30Minute" and "30-minute" are one id. */
function normaliseServiceKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}
/**
 * Minutes a raw booking label states, for catalog matching only.
 *
 * Two readings, in order. A stated unit wins ("60Mins", "30 Minute", "2Hrs"),
 * through the same `serviceDurationMinutes` parse the New booking dialog and
 * the Schedule legend already order services by. Failing that, a BARE trailing
 * number is read as minutes: that is the `visit_60` shape this collection's
 * older rows carry, and minutes is the only unit any of these ids has ever
 * counted in.
 *
 * The bare read is deliberately the weaker of the two and never decides a name
 * on its own: `bookingServiceName` only uses these minutes when EXACTLY ONE
 * configured KinCare runs that long, so a label like "Walk 2" resolves to
 * nothing rather than to a two-minute visit.
 */
function labelMinutes(label: string): number | null {
  const stated = serviceDurationMinutes(label);
  if (stated !== null) return stated;
  const bare = /(?:^|[^0-9A-Za-z])(\d{1,4})$/.exec(label);
  if (!bare) return null;
  const minutes = Number(bare[1]);
  return minutes > 0 ? minutes : null;
}
/**
 * What a booking's service is CALLED, resolved against the operator's catalog.
 *
 * `kin_care_sessions.serviceType` is free text and the live collection holds at
 * least four spellings of the same handful of services: `visit_60`, `60Mins`,
 * `30 Minute`, `30Minute`. Those are ids and near-ids, not names, and a list
 * that prints them raw asks the operator to translate every row (#704).
 *
 * Resolution, in order:
 *   1. The catalog key itself, matched on letters and digits alone, so
 *      `30 Minute` and `30Minute` both land on the configured `30Minute`.
 *   2. The one catalog entry that runs for the length the label states, when
 *      there is exactly one. This is what reaches `visit_60` and `60Mins`,
 *      neither of which is any catalog key spelled differently. Ambiguous
 *      (two 60-minute KinCares) resolves to nothing rather than to a guess.
 *
 * UNRESOLVED FALLS BACK TO THE RAW LABEL, never to a placeholder: a service
 * the operator has since renamed or removed still says what the visit was
 * booked as. Only a genuinely blank field becomes "Visit".
 *
 * The name returned is the catalog KEY, which is what `KinCareRatesEditor`,
 * the New booking dialog and the Schedule legend all display, so a row here
 * and a row in Settings call the same service the same thing.
 */
export function bookingServiceName(
  rawServiceType: string | undefined,
  catalog: BookingCatalog,
): string {
  const label = str(rawServiceType).trim();
  if (label === '') return 'Visit';
  const keys = Object.keys(catalog.serviceRates)
    .map((key) => key.trim())
    .filter((key) => key !== '');
  const wanted = normaliseServiceKey(label);
  const exact = keys.find((key) => normaliseServiceKey(key) === wanted);
  if (exact !== undefined) return exact;
  const minutes = labelMinutes(label);
  if (minutes !== null) {
    const sameLength = keys.filter(
      (key) =>
        (storedDurationMinutes(catalog.serviceDurations[key]) ?? serviceDurationMinutes(key)) ===
        minutes,
    );
    if (sameLength.length === 1) return sameLength[0]!;
  }
  return label;
}
/** What {@link bookingMetaLine} reads off a row. */
export type BookingMetaInput = BookingWhenInput & { serviceType?: string | undefined };
/**
 * THE ONE LINE UNDER A BOOKING'S NAME: "60Minute · Jul 22 · Morning block".
 *
 * Service, then the visit's date, then the window it sits in. The window is the
 * operator's own named time block when the start time falls inside an active
 * one (`lib/businessOperations.ts#resolveTimeBlock`, the port of Android's
 * `TimeBlockResolver`), and the clock time when it does not, because a visit
 * booked before the blocks existed still happens at a real hour.
 *
 * ONE FORMATTER, not three call sites agreeing. Before this the row pasted the
 * raw `serviceType` next to `bookingWhen`'s combined "Jul 22, 2:00 PM", so
 * thirteen rows showed four different spellings of two services and no row
 * named its block at all.
 *
 * The fail-loud rules `bookingWhen` established are kept exactly: a stored
 * stamp that will not parse is printed VERBATIM rather than hidden, and a row
 * with nothing parseable anywhere says "Date pending" rather than inventing a
 * date. Neither case invents an empty third segment.
 */
export function bookingMetaLine(row: BookingMetaInput, catalog: BookingCatalog): string {
  const service = bookingServiceName(row.serviceType, catalog);
  const raw = str(row.startTime).trim() || str(row.completedAt).trim() || str(row.departedAt).trim();
  const when =
    raw !== '' ? parseFlexibleDate(raw) : row.createdAt ? row.createdAt.toDate() : null;
  if (when === null) return `${service} · ${raw !== '' ? raw : 'Date pending'}`;
  const block = resolveTimeBlock(when.getHours() * 60 + when.getMinutes(), catalog.timeBlocks);
  const label = (block?.label ?? '').trim();
  // "Morning" reads as "Morning block", the way the mock and the Android card
  // both name a window; an operator who already typed "Morning block" is not
  // given it twice.
  const window =
    label === ''
      ? formatLocalTime(when)
      : /\bblock$/i.test(label)
        ? label
        : `${label} block`;
  return `${service} · ${formatLocalDate(when)} · ${window}`;
}
