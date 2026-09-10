import type { Timestamp } from 'firebase/firestore';
import { dayKey, formatWhen, type FsTime } from './time';
import { localDateIso } from './invoiceFormat';

/**
 * Pure Sessions ("Auntie Time") classification + display helpers, kept out of
 * the screen so the mapping logic has direct vitest coverage (the
 * invoiceFormat.ts / denFormat.ts convention).
 *
 * ── THE AO-18 FIX, non-negotiable per the port brief ──────────────────────
 * `kin_care_sessions.startTime`/`endTime`/`completedAt` are free-text ISO-8601
 * STRINGS on the source doc, not Firestore Timestamps, confirmed against
 * `createKinCareSession.ts`'s zod schema (`startTime: z.string().min(1).max(40)`)
 * and `approveBookingSeriesCore.ts`'s `toIso()` helper, which stamps them via
 * `FieldValue.serverTimestamp().toDate().toISOString()`, i.e. a UTC-suffixed
 * ("...Z") instant string. The wasm's `KinCareSessionsScreen.kt` groups and
 * displays these by slicing the raw string directly:
 *   `session.startTime.take(10)` for the day, `shortDateTime`/`shortTime`
 *   substring-slicing the ISO text for the clock.
 * Both slice the UTC characters as if they were already local. An 8pm-CDT
 * session serializes to "...T01:00:00.000Z" (next calendar day in UTC), so
 * `.take(10)` groups it under TOMORROW and shows the UTC hour, five hours off
 * from what actually happened. That is AO-18.
 *
 * `sessionTimeOf` below is the fix: it parses the ISO string into a real `Date`
 * and hands it to `lib/time.ts`'s `dayKey`/`formatWhen`, the same LOCAL
 * (`getFullYear`/`getMonth`/`getDate`/`getHours`/`getMinutes`) helpers every
 * other Timestamp-backed screen in this port already uses, via a minimal
 * fake-`Timestamp` wrapper (`{ toDate: () => Date }`), rather than duplicating
 * local-time arithmetic here. `lib/time.ts` itself is left untouched: it
 * already has no notion of a raw ISO string, and giving it one here (via the
 * wrapper) is the smallest change that reuses its LOCAL day/time logic
 * verbatim instead of re-deriving it.
 */

// ── ISO-string → local day/time (the AO-18 fix) ─────────────────────────────

/**
 * Wraps a `kin_care_sessions` free-text ISO timestamp field as a fake Firestore
 * `Timestamp` so it can flow through `lib/time.ts`'s LOCAL `dayKey`/`formatWhen`
 * unchanged. `null` for blank/unparseable input, same "degrade honestly, never
 * fabricate a date" contract `lib/time.ts` already uses for a genuinely absent
 * Timestamp.
 */
export function sessionTimeOf(iso: string): FsTime {
  const trimmed = (iso ?? '').trim();
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return { toDate: () => d } as unknown as Timestamp;
}

/** LOCAL `YYYY-MM-DD` day-grouping key for a session ISO field, or `'Undated'`. */
export function sessionDayKey(iso: string): string {
  return dayKey(sessionTimeOf(iso));
}

/**
 * LOCAL `HH:mm` clock time for one session ISO field. Reuses `formatWhen`'s
 * `MM-DD HH:mm` in full and takes only the time half (`.slice(6)`), rather than
 * re-deriving hour/minute padding here, the day is already carried by the row's
 * day-group header, so repeating it per-row would be noise, not a second AO-18
 * check. The `'(no time)'` fallback is returned verbatim (it is shorter than 6
 * characters would slice cleanly to anyway, so it is special-cased rather than
 * silently truncated).
 */
export function sessionClock(iso: string): string {
  const full = formatWhen(sessionTimeOf(iso));
  return full === '(no time)' ? full : full.slice(6);
}

/**
 * "09:00 to 17:00", ported from the wasm's `sessionWindow`. "Time TBD" only when
 * BOTH ends are unparseable, a session with a start but no end still shows the
 * start rather than collapsing to a blanket "TBD" (matches the wasm exactly).
 */
export function sessionWindow(startIso: string, endIso: string): string {
  const start = sessionClock(startIso);
  const end = sessionClock(endIso);
  const startKnown = start !== '(no time)';
  const endKnown = end !== '(no time)';
  if (!startKnown && !endKnown) return 'Time TBD';
  if (!endKnown) return start;
  if (!startKnown) return end;
  return `${start} to ${end}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whole-calendar-day difference `b - a` for two `YYYY-MM-DD` strings, via UTC-anchored arithmetic (no time-of-day involved, so no zone ambiguity). */
function daysBetween(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.split('-').map(Number);
  const [by, bm, bd] = bIso.split('-').map(Number);
  const aUtc = Date.UTC(ay ?? 1970, (am ?? 1) - 1, ad ?? 1);
  const bUtc = Date.UTC(by ?? 1970, (bm ?? 1) - 1, bd ?? 1);
  return Math.round((bUtc - aUtc) / 86_400_000);
}

/**
 * Friendly day-group header: "Today" / "Tomorrow" / "Yesterday" relative to
 * [todayIso] (a LOCAL `YYYY-MM-DD`, e.g. from `localDateIso(new Date())`), else
 * "Thu, Jul 16". `'Undated'` passes through verbatim, a session with no
 * parseable start time gets its own honest group, never folded into "Today".
 */
export function sessionDayLabel(dayKeyValue: string, todayIso: string): string {
  if (dayKeyValue === 'Undated') return dayKeyValue;
  const diff = daysBetween(todayIso, dayKeyValue);
  // Relative labels win over the year rule below: "Yesterday" is unambiguous
  // even when it falls on the other side of a New Year.
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const parts = dayKeyValue.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  // Local-noon anchor (not midnight) so no DST-transition edge case can roll
  // the weekday over a day in either direction.
  const asDate = new Date(y, m - 1, d, 12);
  const weekday = WEEKDAYS[asDate.getDay()] ?? '';
  const month = MONTHS[m - 1] ?? '';
  // The YEAR, when it is not the current one. Without it a visit from last
  // January read as "Thu, Jan 16", identical to this January (operator issue
  // #17). Omitted in the current year so the common case stays uncluttered.
  const currentYear = Number(todayIso.slice(0, 4));
  const suffix = Number.isFinite(currentYear) && y !== currentYear ? `, ${y}` : '';
  return `${weekday}, ${month} ${d}${suffix}`;
}

// ── household display ────────────────────────────────────────────────────

/** "Unnamed Kinfolk" fallback, matching `directory.ts#kinfolkDisplayName`'s convention, `kinfolkName` is blank on a session created via the ad-hoc `createKinCareSession` callable, which does not stamp it. */
export function sessionHousehold(kinfolkName: string): string {
  const name = (kinfolkName ?? '').trim();
  return name === '' ? 'Unnamed Kinfolk' : name;
}

// ── status classification (positive enumeration, no negation) ──────────────

/**
 * Every state this module will ever return. Mirrors the six SCREAMING_SNAKE
 * codes every real writer sets on `kin_care_sessions.status`
 * (`createKinCareSession.ts`, `approveBookingSeriesCore.ts`, and the wasm
 * `patchKinCare` calls in `KinCareSessionsScreen.kt`'s `ActionRow`/`KebabMenu`):
 * SCHEDULED, ON_MY_WAY, ARRIVED, DEPARTED, COMPLETED, CANCELLED. `'unknown'` is
 * the one state no writer produces today, it exists only so a status string
 * that matches none of the six recognized codes gets an HONEST label instead of
 * being silently folded into whichever bucket the code happened to check first
 * (the AO-12 lesson: every branch here is a positive match against the literal
 * text, never "not one of the others, so must be Y").
 */
export type SessionState =
  | 'scheduled'
  | 'onMyWay'
  | 'arrived'
  | 'departed'
  | 'completed'
  | 'cancelled'
  | 'unknown';

/** Classifies one session's free-text `status`, case-insensitively (mirrors the wasm's own `.uppercase()` compare). */
export function sessionState(status: string): SessionState {
  switch ((status ?? '').trim().toUpperCase()) {
    case 'SCHEDULED':
      return 'scheduled';
    case 'ON_MY_WAY':
      return 'onMyWay';
    case 'ARRIVED':
      return 'arrived';
    case 'DEPARTED':
      return 'departed';
    case 'COMPLETED':
      return 'completed';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

export interface SessionStateInfo {
  label: string;
  chipLabel: string;
  cssClass: string;
}

/** Friendly label + chip class per state. Pure 1:1 map, ported from the wasm's `statusLabel`/`statusTone`. */
export function sessionStateInfo(state: SessionState): SessionStateInfo {
  switch (state) {
    case 'scheduled':
      return { label: 'Scheduled', chipLabel: 'SCHEDULED', cssClass: 'scheduled' };
    case 'onMyWay':
      return { label: 'On the way', chipLabel: 'ON THE WAY', cssClass: 'onmyway' };
    case 'arrived':
      return { label: 'Arrived', chipLabel: 'ARRIVED', cssClass: 'arrived' };
    case 'departed':
      return { label: 'Departed', chipLabel: 'DEPARTED', cssClass: 'departed' };
    case 'completed':
      return { label: 'Completed', chipLabel: 'COMPLETED', cssClass: 'completed' };
    case 'cancelled':
      return { label: 'Cancelled', chipLabel: 'CANCELLED', cssClass: 'cancelled' };
    case 'unknown':
      return { label: 'Unknown', chipLabel: 'UNKNOWN', cssClass: 'unknown' };
  }
}

/** True for the three "in flight" states (ports the wasm `Phase.Active` / `isInFlight` grouping). A positive membership test, not a negation of the other four. */
export function isSessionActive(state: SessionState): boolean {
  return state === 'onMyWay' || state === 'arrived' || state === 'departed';
}

// ── day grouping ─────────────────────────────────────────────────────────

/** One local calendar day's worth of rows, chronologically sorted within the day. */
export interface SessionDayGroup<T> {
  dayKeyValue: string;
  rows: T[];
}

function epochOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Groups rows by LOCAL day (via `sessionDayKey`, the AO-18 fix), sorts each
 * day's rows chronologically ascending by `startTime`, and orders the day
 * groups themselves chronologically with `'Undated'` always last, never
 * interleaved by whatever order the bounded stream happened to deliver rows
 * in (see `SESSIONS_QUERY` in `api/sessions.ts` for why the stream's own order
 * is `startTime desc`, a different concern from this display order).
 */
export function groupSessionsByDay<T extends { startTime?: string | undefined }>(
  rows: T[],
): SessionDayGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    // `startTime` is optional on the row type because `SessionEntry` is a cast
    // over raw Firestore data, not a validation of it (see `api/sessions.ts`).
    // A row missing it lands in the 'Undated' group, exactly where a blank or
    // unparseable `startTime` already landed, rather than throwing here and
    // taking the whole list down.
    const key = sessionDayKey(row.startTime ?? '');
    const existing = map.get(key);
    if (existing) existing.push(row);
    else map.set(key, [row]);
  }
  const groups = Array.from(map.entries()).map(([dayKeyValue, groupRows]) => ({
    dayKeyValue,
    rows: [...groupRows].sort((a, b) => epochOf(a.startTime ?? '') - epochOf(b.startTime ?? '')),
  }));
  groups.sort((a, b) => {
    if (a.dayKeyValue === 'Undated') return b.dayKeyValue === 'Undated' ? 0 : 1;
    if (b.dayKeyValue === 'Undated') return -1;
    return a.dayKeyValue < b.dayKeyValue ? -1 : a.dayKeyValue > b.dayKeyValue ? 1 : 0;
  });
  return groups;
}

// ── phase grouping: the Auntie Time window (issues #17, #702, #703) ─────────
//
// This is the DAY-OF BOARD the `auntieos-auntie-time-2026-05-27` mock draws:
// four phase groups of action cards, ported from the archive's
// `KinCareSessionsScreen.kt` phases (`Phase.Active` / `Upcoming` /
// `CompletedToday`, labelled "Recent") and its `isVisibleOnAuntieTime` day-of
// filter. Issue #17 gave the screen a bounded window in the first place, since
// `SESSIONS_QUERY` used to stream a flat 300 rows with no date predicate and a
// visit from March sat beside tomorrow's.
//
// THE WINDOW BOUNDARIES, and why each is where it is:
//
//  RECENT, 1 day back: today or yesterday, which is what the mock labels its
//    Recent group ("COMPLETED / CANCELLED today or yesterday"). Issue #17 read
//    "recent" as the span in which a wrap is still a live question and widened
//    it to a week; the mock is the operator's ruling and it is narrower, so the
//    week is gone (#703). Anything older is behind the Archive. Measured on the
//    WRAP day (completedAt, falling back to startTime, because a CANCELLED
//    session never gets a completedAt).
//  OVERDUE, added for issue #702. A visit still sitting at SCHEDULED once its
//    slot is more than a day gone is the single row an operator most needs to
//    see, so it gets its own group between Active and Upcoming rather than
//    being dropped. (It used to fall inside UPCOMING's one-day look-back and
//    nowhere past that, which is exactly the bug: `sessionPhase` returned
//    `null` for anything older, and `groupSessionsByPhase` drops nulls, so a
//    SCHEDULED row that missed its slot by more than a day disappeared from
//    the board entirely.) Bounded only by the
//    FETCH range, same as Upcoming and Recent; anything the query never
//    fetched is not this module's problem.
//  UPCOMING, 14 days forward, one day BACK (unchanged: "yesterday" is still
//    Upcoming, not Overdue, since a visit that missed its slot by less than a
//    day reads as "today's run sheet", not yet a problem case).
//  ACTIVE, no date bound at all. An in-flight visit is in flight whatever its
//    startTime says; a clock-in nobody closed must never fall out of the list.
//    (The FETCH range still bounds it; see `sessionsWindowBounds`.)
//
// Anything outside those lives behind the Archive affordance in `Sessions.tsx`.

export type SessionPhase = 'active' | 'overdue' | 'upcoming' | 'recent';

/**
 * Sort direction, applied WITHIN a phase and never across phases.
 *
 * NO CONTROL EXPOSES THIS ANY MORE. The Sort select went with #703 (the mock
 * has none, and a run sheet reads forwards), so every caller passes the
 * `'soonest'` default. The parameter stays because the ordering rule it names
 * is real and tested: "latest first" is the ascending order read backwards on
 * both axes, which is the property a future control would have to preserve.
 */
export type SessionSort = 'soonest' | 'latest';

export const RECENT_WINDOW_DAYS = 1;
export const UPCOMING_WINDOW_DAYS = 14;

/**
 * How far the bounded FETCH reaches, which is deliberately wider than the
 * display window above.
 *
 * Back 30 rather than 1, because Active and Overdue carry no lower date bound:
 * a visit clocked in three weeks ago and never completed, or one still sitting
 * at SCHEDULED a fortnight after its slot, both have to reach the board,
 * and neither can if the query never fetched it. Forward 15 rather than 14, to
 * absorb the UTC-vs-local boundary: the query compares raw ISO text while
 * grouping parses to a LOCAL day, so a row can sit one calendar day either side
 * of where the string sort puts it. Fetching the extra day and letting
 * `groupSessionsByPhase` decide keeps that seam out of the query.
 */
export const FETCH_DAYS_BACK = 30;
export const FETCH_DAYS_FORWARD = 15;

/** Shift a `YYYY-MM-DD` day by whole days, via UTC-anchored arithmetic (no time-of-day, so no zone ambiguity). */
export function shiftDayIso(dayIso: string, days: number): string {
  const [y, m, d] = dayIso.split('-').map(Number);
  const shifted = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  const yy = String(shifted.getUTCFullYear()).padStart(4, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** The inclusive `YYYY-MM-DD` range the bounded listener should fetch. */
export function sessionsWindowBounds(todayIso: string): { from: string; to: string } {
  return {
    from: shiftDayIso(todayIso, -FETCH_DAYS_BACK),
    to: shiftDayIso(todayIso, FETCH_DAYS_FORWARD),
  };
}

/**
 * The states the BOOKINGS screen owns, never shown on Auntie Time (the
 * archive's AO-60 note: a booking surfaces here only once it is approved to
 * SCHEDULED). A positive membership test against the literal codes, so an
 * unrecognized status is NOT swept in here by accident, it lands in Upcoming
 * with its own honest UNKNOWN chip.
 */
const BOOKING_QUEUE_STATUSES: readonly string[] = ['DRAFT', 'PENDING', 'REJECTED'];

export function isBookingQueueStatus(status: string): boolean {
  return BOOKING_QUEUE_STATUSES.includes((status ?? '').trim().toUpperCase());
}

/** The row shape phase grouping needs. Every field optional, for the same reason `SessionEntry`'s are. */
export interface PhaseRow {
  startTime?: string | undefined;
  status?: string | undefined;
  completedAt?: string | undefined;
}

/**
 * Which phase a row belongs to, or `null` when it falls outside the window and
 * belongs behind the Archive affordance instead. [todayIso] is a LOCAL
 * `YYYY-MM-DD`.
 */
export function sessionPhase(row: PhaseRow, todayIso: string): SessionPhase | null {
  const status = row.status ?? '';
  if (isBookingQueueStatus(status)) return null;

  const state = sessionState(status);
  if (isSessionActive(state)) return 'active';

  if (state === 'completed' || state === 'cancelled') {
    // A cancellation has no completedAt, so it is dated by when it was meant to
    // happen. Falling back rather than dropping it is what puts a cancelled
    // visit in Recent beside the completed ones, exactly as the mock draws it.
    const wrapDay = sessionDayKey(row.completedAt ?? '') === 'Undated'
      ? sessionDayKey(row.startTime ?? '')
      : sessionDayKey(row.completedAt ?? '');
    if (wrapDay === 'Undated') return null;
    const diff = daysBetween(todayIso, wrapDay);
    return diff <= 0 && diff >= -RECENT_WINDOW_DAYS ? 'recent' : null;
  }

  // SCHEDULED, plus any status code no writer produces today (AO-12: placed by
  // its date, which we do know, rather than dropped for a word we don't).
  const startDay = sessionDayKey(row.startTime ?? '');
  if (startDay === 'Undated') return null;
  const diff = daysBetween(todayIso, startDay);
  if (diff > UPCOMING_WINDOW_DAYS) return null;
  // issue #702: a slot missed by more than a day is OVERDUE, not dropped.
  return diff >= -1 ? 'upcoming' : 'overdue';
}

/** One phase's rows, still sub-grouped by local day so the day headers survive. */
export interface SessionPhaseGroup<T> {
  phase: SessionPhase;
  label: string;
  /** Total rows across every day in this phase, for the group's count chip. */
  count: number;
  days: SessionDayGroup<T>[];
}

// Overdue sits between Active and Upcoming (issue #702): a slot that already
// passed with nobody clocking in is more urgent than one still ahead of us,
// so it reads right after what's in flight right now. Active, Upcoming and
// Recent keep the exact relative order the archive always had.
export const PHASE_ORDER: readonly SessionPhase[] = ['active', 'overdue', 'upcoming', 'recent'];

export const PHASE_LABEL: Record<SessionPhase, string> = {
  active: 'Active',
  overdue: 'Overdue',
  upcoming: 'Upcoming',
  recent: 'Recent',
};

/**
 * Group rows into Active / Overdue / Upcoming / Recent, each still sub-grouped
 * by LOCAL day, dropping anything outside the window (see `sessionPhase`).
 * Phases keep the fixed order above; [sort] reverses days and rows WITHIN a
 * phase only, so "latest first" never puts Recent above Active.
 *
 * ALL FOUR GROUPS ARE ALWAYS RETURNED, empty ones included, and that is the
 * #703 change. They used to be skipped, which is how the operator reached a
 * frame that said "9 visits fetched" over a single empty hint: an empty phase
 * had nothing to say, so the board said nothing at all and read as broken. The
 * mock draws every phase with its count chip whether or not it has cards, and
 * a chip that says 0 is an answer. The screen decides how an empty group
 * renders; this function's job is to stop hiding it.
 */
export function groupSessionsByPhase<T extends PhaseRow>(
  rows: readonly T[],
  todayIso: string,
  sort: SessionSort = 'soonest',
): SessionPhaseGroup<T>[] {
  const byPhase = new Map<SessionPhase, T[]>();
  for (const row of rows) {
    const phase = sessionPhase(row, todayIso);
    if (phase === null) continue;
    const existing = byPhase.get(phase);
    if (existing) existing.push(row);
    else byPhase.set(phase, [row]);
  }

  return PHASE_ORDER.map((phase) => {
    const phaseRows = byPhase.get(phase) ?? [];
    // `groupSessionsByDay` already returns days ascending with rows ascending
    // inside each; "latest first" is that same ordering read backwards, on both
    // axes, so a day's rows stay consistent with the day order around them.
    const days = groupSessionsByDay(phaseRows);
    const ordered =
      sort === 'latest'
        ? [...days].reverse().map((d) => ({ ...d, rows: [...d.rows].reverse() }))
        : days;
    return { phase, label: PHASE_LABEL[phase], count: phaseRows.length, days: ordered };
  });
}

/** Re-exported so screens/tests needn't also import `lib/invoiceFormat` just for "today, as a local date". */
export { localDateIso };
