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
  return `${weekday}, ${month} ${d}`;
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
export function groupSessionsByDay<T extends { startTime: string }>(rows: T[]): SessionDayGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = sessionDayKey(row.startTime);
    const existing = map.get(key);
    if (existing) existing.push(row);
    else map.set(key, [row]);
  }
  const groups = Array.from(map.entries()).map(([dayKeyValue, groupRows]) => ({
    dayKeyValue,
    rows: [...groupRows].sort((a, b) => epochOf(a.startTime) - epochOf(b.startTime)),
  }));
  groups.sort((a, b) => {
    if (a.dayKeyValue === 'Undated') return b.dayKeyValue === 'Undated' ? 0 : 1;
    if (b.dayKeyValue === 'Undated') return -1;
    return a.dayKeyValue < b.dayKeyValue ? -1 : a.dayKeyValue > b.dayKeyValue ? 1 : 0;
  });
  return groups;
}

/** Re-exported so screens/tests needn't also import `lib/invoiceFormat` just for "today, as a local date". */
export { localDateIso };
